<?php

require_once 'idObfuscation.php';

define('TELEMETRY_SETTINGS_FILE', 'telemetry_settings.php');

/**
 * Column list shared by every list-style query. The (potentially huge) log
 * column is deliberately excluded: fetching up to 500 rows must not drag the
 * logs along. Use getSpeedtestUserById() to fetch a single row including log.
 *
 * @return string
 */
function telemetryDbUserColumns()
{
    return 'id, timestamp, ip, ispinfo, ua, lang, dl, ul, ping, jitter, extra, client_id, params';
}

/**
 * Read $db_type from the settings file.
 *
 * @return string
 */
function telemetryDbType()
{
    require TELEMETRY_SETTINGS_FILE;

    return isset($db_type) ? (string) $db_type : '';
}

/**
 * Numeric cast expression for the driver. The measurement columns are TEXT,
 * so comparing them to a number needs an explicit cast on every driver.
 *
 * @param string $dbType
 *
 * @return string
 */
function telemetryDbNumericCast($dbType)
{
    if ('mysql' === $dbType) {
        return 'DECIMAL(20,6)';
    }
    if ('postgresql' === $dbType) {
        return 'DOUBLE PRECISION';
    }
    if ('mssql' === $dbType) {
        return 'FLOAT';
    }

    // sqlite (and anything unknown) understands REAL
    return 'REAL';
}

/**
 * Expression yielding a YYYY-MM-DD day string for the timestamp column.
 *
 * @param string $dbType
 *
 * @return string
 */
function telemetryDbDayExpression($dbType)
{
    if ('mysql' === $dbType) {
        return "DATE_FORMAT(timestamp, '%Y-%m-%d')";
    }
    if ('postgresql' === $dbType) {
        return "to_char(timestamp, 'YYYY-MM-DD')";
    }
    if ('mssql' === $dbType) {
        return 'CONVERT(varchar(10), timestamp, 23)';
    }

    return "strftime('%Y-%m-%d', timestamp)";
}

/**
 * OFFSET/FETCH for MSSQL, LIMIT/OFFSET everywhere else.
 *
 * The limit/offset are cast to int before being interpolated, so no user data
 * ever reaches the SQL string; they are structural pagination values, not
 * bindable parameters.
 *
 * @param string $dbType
 * @param int    $limit
 * @param int    $offset
 *
 * @return string
 */
function telemetryDbLimitSql($dbType, $limit, $offset)
{
    $limit = max(1, (int) $limit);
    $offset = max(0, (int) $offset);

    if ('mssql' === $dbType) {
        return ' OFFSET '.$offset.' ROWS FETCH NEXT '.$limit.' ROWS ONLY ';
    }

    return ' LIMIT '.$limit.' OFFSET '.$offset;
}

/**
 * @param string $order
 * @param string $dbType
 *
 * @return string
 */
function telemetryDbOrderSql($order, $dbType)
{
    $cast = telemetryDbNumericCast($dbType);

    if ('oldest' === $order) {
        return ' ORDER BY timestamp ASC, id ASC ';
    }
    if ('dl' === $order) {
        return ' ORDER BY CAST(dl AS '.$cast.') DESC, id DESC ';
    }
    if ('ul' === $order) {
        return ' ORDER BY CAST(ul AS '.$cast.') DESC, id DESC ';
    }

    return ' ORDER BY timestamp DESC, id DESC ';
}

/**
 * Normalize a date/datetime filter value.
 *
 * Accepts YYYY-MM-DD, YYYY-MM-DD HH:MM and YYYY-MM-DD HH:MM:SS (a T separator
 * is also accepted). Date-only values are widened to the whole day so a "to"
 * filter includes the rows recorded during that day.
 *
 * @param mixed $value
 * @param bool  $endOfDay
 *
 * @return string|null normalized "YYYY-MM-DD HH:MM:SS" or null when invalid
 */
function telemetryDbNormalizeDateTime($value, $endOfDay)
{
    $value = trim((string) $value);
    if ('' === $value) {
        return null;
    }

    if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m)) {
        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            return null;
        }

        return $value.($endOfDay ? ' 23:59:59' : ' 00:00:00');
    }

    if (preg_match('/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/', $value, $m)) {
        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            return null;
        }
        $seconds = isset($m[6]) && '' !== $m[6] ? $m[6] : '00';
        if ((int) $m[4] > 23 || (int) $m[5] > 59 || (int) $seconds > 59) {
            return null;
        }

        return $m[1].'-'.$m[2].'-'.$m[3].' '.$m[4].':'.$m[5].':'.$seconds;
    }

    return null;
}

/**
 * Turn the supported filter keys into SQL clauses plus bound parameters.
 *
 * Supported keys: q, ip, from, to, min_dl, min_ul, client_id, id.
 *
 * @param array  $filters
 * @param string $dbType
 *
 * @return array [string[] $clauses, array $params]
 */
function telemetryDbBuildFilterClauses(array $filters, $dbType)
{
    $clauses = [];
    $params = [];

    if (isset($filters['client_id']) && '' !== (string) $filters['client_id']) {
        $clauses[] = 'client_id = :f_client_id';
        $params[':f_client_id'] = (string) $filters['client_id'];
    }

    if (isset($filters['id']) && '' !== (string) $filters['id'] && ctype_digit((string) $filters['id'])) {
        $clauses[] = 'id = :f_id';
        $params[':f_id'] = (int) $filters['id'];
    }

    if (isset($filters['ip']) && '' !== trim((string) $filters['ip'])) {
        $clauses[] = 'ip = :f_ip';
        $params[':f_ip'] = trim((string) $filters['ip']);
    }

    if (isset($filters['q']) && '' !== trim((string) $filters['q'])) {
        // Escape the LIKE wildcards with '!' so a literal % or _ in the search
        // box cannot turn into a wildcard.
        $needle = str_replace(['!', '%', '_'], ['!!', '!%', '!_'], trim((string) $filters['q']));
        $needle = '%'.$needle.'%';
        // Distinct placeholders: with emulated prepares turned off PDO cannot
        // reuse one named placeholder several times.
        $clauses[] = "(ip LIKE :f_q_ip ESCAPE '!'"
            ." OR ispinfo LIKE :f_q_ispinfo ESCAPE '!'"
            ." OR ua LIKE :f_q_ua ESCAPE '!'"
            ." OR extra LIKE :f_q_extra ESCAPE '!'"
            ." OR client_id LIKE :f_q_client_id ESCAPE '!')";
        $params[':f_q_ip'] = $needle;
        $params[':f_q_ispinfo'] = $needle;
        $params[':f_q_ua'] = $needle;
        $params[':f_q_extra'] = $needle;
        $params[':f_q_client_id'] = $needle;
    }

    $from = telemetryDbNormalizeDateTime(isset($filters['from']) ? $filters['from'] : null, false);
    if (null !== $from) {
        $clauses[] = 'timestamp >= :f_from';
        $params[':f_from'] = $from;
    }

    $to = telemetryDbNormalizeDateTime(isset($filters['to']) ? $filters['to'] : null, true);
    if (null !== $to) {
        $clauses[] = 'timestamp <= :f_to';
        $params[':f_to'] = $to;
    }

    foreach (['min_dl' => 'dl', 'min_ul' => 'ul'] as $key => $column) {
        if (!isset($filters[$key]) || !is_numeric($filters[$key])) {
            continue;
        }
        $clauses[] = '('.$column.' IS NOT NULL AND '.$column." <> ''"
            .' AND CAST('.$column.' AS '.telemetryDbNumericCast($dbType).') >= :f_'.$key.')';
        // sprintf() keeps the decimal separator locale independent.
        $params[':f_'.$key] = sprintf('%.6F', (float) $filters[$key]);
    }

    return [$clauses, $params];
}

/**
 * @param string[] $clauses
 *
 * @return string
 */
function telemetryDbWhere(array $clauses)
{
    if (empty($clauses)) {
        return '';
    }

    return ' WHERE '.implode(' AND ', $clauses);
}

/**
 * @param PDOStatement $stmt
 * @param array        $params
 *
 * @return void
 */
function telemetryDbBindParams(PDOStatement $stmt, array $params)
{
    foreach ($params as $name => $value) {
        $stmt->bindValue($name, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
}

/**
 * Add the "id_formatted" field (and the existing obfuscation behaviour) to rows.
 *
 * @param array $rows
 *
 * @return array
 */
function telemetryDbFormatRows(array $rows)
{
    $obfuscated = isObfuscationEnabled();

    foreach ($rows as $i => $row) {
        $rows[$i]['id_formatted'] = $row['id'];
        if ($obfuscated) {
            $rows[$i]['id_formatted'] = obfuscateId($row['id']).' (deobfuscated: '.$row['id'].')';
        }
    }

    return $rows;
}

/**
 * Best effort, short and readable ISP label from the stored ispinfo JSON.
 *
 * Never returns the raw blob: when the stored value is an unparseable JSON
 * document an empty string is returned instead of dumping it to the caller.
 *
 * @param string|null $ispinfo
 *
 * @return string at most 200 characters
 */
function telemetryIspLabel($ispinfo)
{
    $text = trim((string) $ispinfo);
    if ('' === $text) {
        return '';
    }

    $decoded = json_decode($text, true);
    if (is_array($decoded) && isset($decoded['processedString']) && is_string($decoded['processedString'])) {
        return telemetryDbTruncateLabel($decoded['processedString']);
    }

    if (preg_match('/"processedString"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/', $text, $m)) {
        $label = json_decode('"'.$m[1].'"');
        if (is_string($label)) {
            return telemetryDbTruncateLabel($label);
        }
    }

    $first = substr($text, 0, 1);
    if ('{' === $first || '[' === $first) {
        return '';
    }

    return telemetryDbTruncateLabel(preg_replace('/\s+/', ' ', $text));
}

/**
 * @param string|null $text
 *
 * @return string at most 200 characters
 */
function telemetryDbTruncateLabel($text)
{
    $text = trim((string) $text);
    if (function_exists('mb_substr')) {
        return mb_substr($text, 0, 200, 'UTF-8');
    }

    return substr($text, 0, 200);
}

/**
 * CREATE TABLE statement for the driver, including the telemetry columns added
 * for client_id/params. Returns null for an unknown driver.
 *
 * @param string $dbType
 *
 * @return string|null
 */
function telemetryDbCreateTableSql($dbType)
{
    if ('sqlite' === $dbType) {
        return '
                CREATE TABLE IF NOT EXISTS `speedtest_users` (
                `id`        INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                `ispinfo`   text,
                `extra`     text,
                `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
                `ip`        text NOT NULL,
                `ua`        text NOT NULL,
                `lang`      text NOT NULL,
                `dl`        text,
                `ul`        text,
                `ping`      text,
                `jitter`    text,
                `log`       longtext,
                `client_id` text,
                `params`    text
                );
            ';
    }

    if ('mysql' === $dbType) {
        return 'CREATE TABLE IF NOT EXISTS `speedtest_users` ('
            .'`id` int(11) NOT NULL AUTO_INCREMENT,'
            .'`timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,'
            .'`ip` text NOT NULL,'
            .'`ispinfo` text,'
            .'`extra` text,'
            .'`ua` text NOT NULL,'
            .'`lang` text NOT NULL,'
            .'`dl` text,'
            .'`ul` text,'
            .'`ping` text,'
            .'`jitter` text,'
            .'`log` longtext,'
            .'`client_id` text,'
            .'`params` text,'
            .'PRIMARY KEY (`id`)'
            .') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    }

    if ('postgresql' === $dbType) {
        return 'CREATE TABLE IF NOT EXISTS speedtest_users ('
            .'id serial NOT NULL PRIMARY KEY,'
            .'"timestamp" timestamp without time zone DEFAULT now() NOT NULL,'
            .'ip text NOT NULL,'
            .'ispinfo text,'
            .'extra text,'
            .'ua text NOT NULL,'
            .'lang text NOT NULL,'
            .'dl text,'
            .'ul text,'
            .'ping text,'
            .'jitter text,'
            .'log text,'
            .'client_id text,'
            .'params text'
            .')';
    }

    if ('mssql' === $dbType) {
        return 'IF OBJECT_ID(N\'dbo.speedtest_users\', N\'U\') IS NULL '
            .'CREATE TABLE [dbo].[speedtest_users] ('
            .'[id] [bigint] IDENTITY(1,1) NOT NULL PRIMARY KEY,'
            .'[timestamp] [datetime] NOT NULL DEFAULT (getdate()),'
            .'[ip] [nvarchar](max) NOT NULL,'
            .'[ispinfo] [nvarchar](max) NULL,'
            .'[extra] [nvarchar](max) NULL,'
            .'[ua] [nvarchar](max) NOT NULL,'
            .'[lang] [nvarchar](max) NOT NULL,'
            .'[dl] [nvarchar](max) NULL,'
            .'[ul] [nvarchar](max) NULL,'
            .'[ping] [nvarchar](max) NULL,'
            .'[jitter] [nvarchar](max) NULL,'
            .'[log] [nvarchar](max) NULL,'
            .'[client_id] [nvarchar](64) NULL,'
            .'[params] [nvarchar](max) NULL'
            .')';
    }

    return null;
}

/**
 * Definitions of the columns added by the LibreSpeedex telemetry migration,
 * keyed by column name.
 *
 * @param string $dbType
 *
 * @return array
 */
function telemetryDbNewColumnDefinitions($dbType)
{
    if ('mssql' === $dbType) {
        return [
            'client_id' => '[nvarchar](64) NULL',
            'params' => '[nvarchar](max) NULL',
        ];
    }
    if ('mysql' === $dbType) {
        return [
            'client_id' => 'text NULL',
            'params' => 'text NULL',
        ];
    }

    return [
        'client_id' => 'TEXT',
        'params' => 'TEXT',
    ];
}

/**
 * Existing lower-cased column names of speedtest_users.
 *
 * @param PDO    $pdo
 * @param string $dbType
 *
 * @return array column name => true
 */
function telemetryDbExistingColumns(PDO $pdo, $dbType)
{
    $columns = [];

    if ('sqlite' === $dbType) {
        $stmt = $pdo->query('PRAGMA table_info(speedtest_users)');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            if (isset($row['name'])) {
                $columns[strtolower((string) $row['name'])] = true;
            }
        }

        return $columns;
    }

    if ('mysql' === $dbType) {
        $stmt = $pdo->query('SHOW COLUMNS FROM speedtest_users');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            if (isset($row['Field'])) {
                $columns[strtolower((string) $row['Field'])] = true;
            }
        }

        return $columns;
    }

    if ('postgresql' === $dbType) {
        $stmt = $pdo->prepare('SELECT column_name FROM information_schema.columns WHERE table_name = :table');
        $stmt->bindValue(':table', 'speedtest_users', PDO::PARAM_STR);
        $stmt->execute();
    } elseif ('mssql' === $dbType) {
        $stmt = $pdo->prepare('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = :table');
        $stmt->bindValue(':table', 'speedtest_users', PDO::PARAM_STR);
        $stmt->execute();
    } else {
        return $columns;
    }

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $name = isset($row['column_name']) ? $row['column_name'] : (isset($row['COLUMN_NAME']) ? $row['COLUMN_NAME'] : null);
        if (null !== $name) {
            $columns[strtolower((string) $name)] = true;
        }
    }

    return $columns;
}

/**
 * Name of the client_id index.
 *
 * @return string
 */
function telemetryDbClientIdIndexName()
{
    return 'idx_speedtest_users_client_id';
}

/**
 * Create the client_id index when it does not exist yet.
 *
 * On mysql a re-run raises "Duplicate key name", which is tolerated.
 *
 * @param PDO    $pdo
 * @param string $dbType
 *
 * @return void
 */
function telemetryDbEnsureClientIdIndex(PDO $pdo, $dbType)
{
    $index = telemetryDbClientIdIndexName();

    if ('sqlite' === $dbType || 'postgresql' === $dbType) {
        $pdo->exec('CREATE INDEX IF NOT EXISTS '.$index.' ON speedtest_users (client_id)');

        return;
    }

    if ('mysql' === $dbType) {
        try {
            // TEXT columns need a prefix length to be indexable on mysql.
            $pdo->exec('CREATE INDEX '.$index.' ON speedtest_users (client_id(64))');
        } catch (Exception $e) {
            if (false === stripos($e->getMessage(), 'duplicate key name')) {
                throw $e;
            }
        }

        return;
    }

    if ('mssql' === $dbType) {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM sys.indexes WHERE name = :name AND object_id = OBJECT_ID(:table)'
        );
        $stmt->bindValue(':name', $index, PDO::PARAM_STR);
        $stmt->bindValue(':table', 'speedtest_users', PDO::PARAM_STR);
        $stmt->execute();
        if (0 === (int) $stmt->fetchColumn()) {
            $pdo->exec('CREATE INDEX '.$index.' ON speedtest_users (client_id)');
        }
    }
}

/**
 * Make sure speedtest_users exists and carries the telemetry columns.
 *
 * Runs at most once per driver/database per request, is entirely best effort
 * and never throws: a failure leaves the caller with the connection it had.
 *
 * @param PDO $pdo
 *
 * @return bool true when the schema is (believed to be) up to date
 */
function ensureSchema(PDO $pdo)
{
    static $ensured = [];

    if (!is_readable(TELEMETRY_SETTINGS_FILE)) {
        return false;
    }

    require TELEMETRY_SETTINGS_FILE;

    if (!isset($db_type)) {
        return false;
    }
    $dbType = (string) $db_type;

    $cacheKey = $dbType;
    if ('sqlite' === $dbType && isset($Sqlite_db_file)) {
        $cacheKey .= '|'.$Sqlite_db_file;
    }
    if (isset($ensured[$cacheKey])) {
        return $ensured[$cacheKey];
    }

    $ok = true;

    try {
        $createSql = telemetryDbCreateTableSql($dbType);
        if (null !== $createSql) {
            try {
                $pdo->exec($createSql);
            } catch (Exception $e) {
                $ok = false;
            }
        }

        try {
            $columns = telemetryDbExistingColumns($pdo, $dbType);
        } catch (Exception $e) {
            $columns = [];
            $ok = false;
        }

        foreach (telemetryDbNewColumnDefinitions($dbType) as $column => $definition) {
            if (isset($columns[$column])) {
                continue;
            }
            try {
                // Identifiers are hardcoded constants here; no user data is interpolated.
                $pdo->exec('ALTER TABLE speedtest_users ADD COLUMN '.$column.' '.$definition);
                $columns[$column] = true;
            } catch (Exception $e) {
                $ok = false;
            }
        }

        try {
            if (isset($columns['client_id'])) {
                telemetryDbEnsureClientIdIndex($pdo, $dbType);
            }
        } catch (Exception $e) {
            $ok = false;
        }
    } catch (Throwable $e) {
        $ok = false;
    }

    $ensured[$cacheKey] = $ok;

    return $ok;
}

/**
 * @return PDO|false
 */
function getPdo($returnErrorMessage = false)
{
    if (
        !file_exists(TELEMETRY_SETTINGS_FILE)
        || !is_readable(TELEMETRY_SETTINGS_FILE)
    ) {
		if($returnErrorMessage){
			return 'missing TELEMETRY_SETTINGS_FILE';
		}
        return false;
    }

    require TELEMETRY_SETTINGS_FILE;

    if (!isset($db_type)) {
		if($returnErrorMessage){
			return "db_type not set in '" . TELEMETRY_SETTINGS_FILE . "'";
		}
        return false;
    }

    $pdoOptions = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
    ];

    try {
        if ('mssql' === $db_type) {
            if (!isset(
                $MsSql_server,
                $MsSql_databasename,
				$MsSql_WindowsAuthentication
            )) {
				if($returnErrorMessage){
					return "Required MSSQL database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }
			
			if (!$MsSql_WindowsAuthentication and
			    !isset(
						$MsSql_username,
						$MsSql_password
						)
				) {
				if($returnErrorMessage){
					return "Required MSSQL database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }
            $dsn = 'sqlsrv:'
                .'server='.$MsSql_server
                .';Database='.$MsSql_databasename;
			
			if($MsSql_TrustServerCertificate === true){
				$dsn = $dsn . ';TrustServerCertificate=1';
			}
			if($MsSql_TrustServerCertificate === false){
				$dsn = $dsn . ';TrustServerCertificate=0';
			}
			
			if($MsSql_WindowsAuthentication){
				$pdo = new PDO($dsn, "", "", $pdoOptions);
			} else {
				$pdo = new PDO($dsn, $MsSql_username, $MsSql_password, $pdoOptions);
			}
			ensureSchema($pdo);

			return $pdo;
        }

        if ('mysql' === $db_type) {
            if (!isset(
                $MySql_hostname,
                $MySql_port,
                $MySql_databasename,
                $MySql_username,
                $MySql_password
            )) {
                if($returnErrorMessage){
					return "Required mysql database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
				return false;
            }

            $dsn = 'mysql:'
                .'host='.$MySql_hostname
                .';port='.$MySql_port
                .';dbname='.$MySql_databasename;

            $pdo = new PDO($dsn, $MySql_username, $MySql_password, $pdoOptions);
            ensureSchema($pdo);

            return $pdo;
        }

        if ('sqlite' === $db_type) {
            if (!isset($Sqlite_db_file)) {
				if($returnErrorMessage){
					return "Required sqlite database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }

			// Check if directory exists and is writable
			$db_dir = dirname($Sqlite_db_file);
			if (!is_dir($db_dir)) {
				if ($returnErrorMessage) {
					return "SQLite database directory does not exist: " . $db_dir . ". Please create it and ensure it's writable by the web server.";
				}
				return false;
			}
			if (!is_writable($db_dir)) {
				if ($returnErrorMessage) {
					return "SQLite database directory is not writable: " . $db_dir . ". Please ensure the web server has write permissions (e.g., chmod 755 or 775).";
				}
				return false;
			}

            $pdo = new PDO('sqlite:'.$Sqlite_db_file, null, null, $pdoOptions);

            # TODO: Why create table only in sqlite mode?
            $pdo->exec(telemetryDbCreateTableSql('sqlite'));

            // Adds the client_id/params columns (and their index) to databases
            // that were created before LibreSpeedex introduced them.
            ensureSchema($pdo);

            return $pdo;
        }

        if ('postgresql' === $db_type) {
            if (!isset(
                $PostgreSql_hostname,
                $PostgreSql_databasename,
                $PostgreSql_username,
                $PostgreSql_password
            )) {
                if($returnErrorMessage){
					return "Required postgresql database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
				return false;
            }

            $dsn = 'pgsql:'
                .'host='.$PostgreSql_hostname
                .';dbname='.$PostgreSql_databasename;

            $pdo = new PDO($dsn, $PostgreSql_username, $PostgreSql_password, $pdoOptions);
            ensureSchema($pdo);

            return $pdo;
        }
    } catch (Exception $e) {
		if($returnErrorMessage){
			return $e->getMessage();
		}
        return false;
    }

	if($returnErrorMessage){
		return "db_type '" . $db_type . "' not supported";
	}
    return false;
}

/**
 * @return bool
 */
function isObfuscationEnabled()
{
    require TELEMETRY_SETTINGS_FILE;

    return
        isset($enable_id_obfuscation)
        && true === $enable_id_obfuscation;
}

/**
 * @param string      $ip
 * @param string      $ispinfo
 * @param string      $extra
 * @param string      $ua
 * @param string      $lang
 * @param string      $dl
 * @param string      $ul
 * @param string      $ping
 * @param string      $jitter
 * @param string      $log
 * @param string|null $clientId               anonymous browser client id
 * @param string|null $params                 JSON snapshot of the measurement parameters
 * @param bool        $returnExceptionOnError
 *
 * @return string|false|Exception returns the id of the inserted column or false on error if returnErrorMessage is false or a error message if returnErrorMessage is true
 */
function insertSpeedtestUser($ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log, $clientId = null, $params = null, $returnExceptionOnError = false)
{
    // Backwards compatibility: before client_id/params existed the 11th
    // argument was $returnExceptionOnError (sanitycheck.php still calls it
    // that way).
    if (is_bool($clientId) && null === $params) {
        $returnExceptionOnError = $clientId;
        $clientId = null;
    }

    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
		if($returnExceptionOnError){
			return new Exception("Failed to get database connection object");
		}
        return false;
    }

    try {
        $stmt = $pdo->prepare(
            'INSERT INTO speedtest_users
        (ip,ispinfo,extra,ua,lang,dl,ul,ping,jitter,log,client_id,params)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        );
        $stmt->execute([
            $ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log, $clientId, $params
        ]);
        $id = $pdo->lastInsertId();
    } catch (Exception $e) {
        // A database that could not be migrated (no ALTER privilege, read-only
        // schema, ...) must keep working as before: fall back to the legacy
        // insert shape when the new columns are missing.
        $missingColumn = false !== stripos($e->getMessage(), 'no such column')
            || false !== stripos($e->getMessage(), 'unknown column')
            || false !== stripos($e->getMessage(), 'invalid column name');
        if (!$missingColumn) {
			if($returnExceptionOnError){
				return $e;
			}
            return false;
        }

        try {
            $stmt = $pdo->prepare(
                'INSERT INTO speedtest_users
            (ip,ispinfo,extra,ua,lang,dl,ul,ping,jitter,log)
            VALUES (?,?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([
                $ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log
            ]);
            $id = $pdo->lastInsertId();
        } catch (Exception $legacyError) {
			if($returnExceptionOnError){
				return $legacyError;
			}
            return false;
        }
    }

    if (isObfuscationEnabled()) {
        return obfuscateId($id);
    }

    return $id;
}

/**
 * @param int|string $id
 * @param bool       $returnExceptionOnError
 * @param bool       $skipObfuscation       when true $id is the raw numeric id
 *
 * @return array|null|false|exception returns the speedtest data as array, null
 *                          if no data is found for the given id or
 *                          false or an exception if there was an error (based on returnExceptionOnError)
 *
 * @throws RuntimeException
 */
function getSpeedtestUserById($id,$returnExceptionOnError = false,$skipObfuscation = false)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
		if($returnExceptionOnError){
			return new Exception("Failed to get database connection object");
		}
        return false;
    }

    if (!$skipObfuscation && isObfuscationEnabled()) {
        $id = deobfuscateId($id);
    }

    try {
        $stmt = $pdo->prepare(
            'SELECT
            id, timestamp, ip, ispinfo, ua, lang, dl, ul, ping, jitter, log, extra, client_id, params
            FROM speedtest_users
            WHERE id = :id'
        );
        $stmt->bindValue(':id', $id, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
		if($returnExceptionOnError){
			return $e;
		}
        return false;
    }

    if (!is_array($row)) {
        return null;
    }

    $row['id_formatted'] = $row['id'];
    if (isObfuscationEnabled()) {
        $row['id_formatted'] = obfuscateId($row['id']).' (deobfuscated: '.$row['id'].')';
    }

    return $row;
}

/**
 * Newest test results of one anonymous client id.
 *
 * @param string $clientId
 * @param int    $limit
 * @param int    $offset
 *
 * @return array|false rows (newest first) or false on database failure
 */
function getSpeedtestUsersByClientId($clientId, $limit = 25, $offset = 0)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    $dbType = telemetryDbType();

    try {
        $sql = 'SELECT '.telemetryDbUserColumns().' FROM speedtest_users'
            .' WHERE client_id = :client_id'
            .' ORDER BY timestamp DESC, id DESC'
            .telemetryDbLimitSql($dbType, $limit, $offset);
        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':client_id', (string) $clientId, PDO::PARAM_STR);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return false;
    }

    return telemetryDbFormatRows($rows);
}

/**
 * Test results matching the given filters.
 *
 * Supported filter keys: q, ip, from, to, min_dl, min_ul, order,
 * client_id, id.
 *
 * @param array $filters
 * @param int   $limit
 * @param int   $offset
 *
 * @return array|false rows or false on database failure
 */
function getSpeedtestUsersFiltered(array $filters, $limit = 50, $offset = 0)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    $dbType = telemetryDbType();
    list($clauses, $params) = telemetryDbBuildFilterClauses($filters, $dbType);
    $order = isset($filters['order']) ? (string) $filters['order'] : 'newest';

    try {
        $sql = 'SELECT '.telemetryDbUserColumns().' FROM speedtest_users'
            .telemetryDbWhere($clauses)
            .telemetryDbOrderSql($order, $dbType)
            .telemetryDbLimitSql($dbType, $limit, $offset);
        $stmt = $pdo->prepare($sql);
        telemetryDbBindParams($stmt, $params);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return false;
    }

    return telemetryDbFormatRows($rows);
}

/**
 * Number of test results matching the given filters.
 *
 * @param array $filters
 *
 * @return int 0 when the database is unavailable
 */
function countSpeedtestUsers(array $filters = [])
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return 0;
    }

    $dbType = telemetryDbType();
    list($clauses, $params) = telemetryDbBuildFilterClauses($filters, $dbType);

    try {
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM speedtest_users'.telemetryDbWhere($clauses));
        telemetryDbBindParams($stmt, $params);
        $stmt->execute();

        return (int) $stmt->fetchColumn();
    } catch (Exception $e) {
        return 0;
    }
}

/**
 * Aggregated telemetry for the given filters.
 *
 * per_day covers the last 30 calendar days (UTC) and only contains days that
 * have data. top_isp lists the 8 most frequent ISP labels.
 *
 * @param array $filters
 *
 * @return array {
 *     total: int, unique_clients: int,
 *     dl_avg: float, dl_max: float, ul_avg: float, ul_max: float,
 *     ping_avg: float, jitter_avg: float,
 *     per_day: array, top_isp: array
 * }
 */
function getSpeedtestStats(array $filters = [])
{
    $stats = [
        'total' => 0,
        'unique_clients' => 0,
        'dl_avg' => 0.0,
        'dl_max' => 0.0,
        'ul_avg' => 0.0,
        'ul_max' => 0.0,
        'ping_avg' => 0.0,
        'jitter_avg' => 0.0,
        'per_day' => [],
        'top_isp' => [],
    ];

    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return $stats;
    }

    $dbType = telemetryDbType();
    $cast = telemetryDbNumericCast($dbType);
    list($clauses, $params) = telemetryDbBuildFilterClauses($filters, $dbType);
    $where = telemetryDbWhere($clauses);

    /**
     * Averages must ignore empty TEXT values ("") instead of counting them
     * as zero.
     */
    $numericCase = function ($column) use ($cast) {
        return 'CASE WHEN '.$column.' IS NOT NULL AND '.$column." <> '' THEN CAST(".$column.' AS '.$cast.') END';
    };

    try {
        $stats['total'] = countSpeedtestUsers($filters);

        $sql = 'SELECT'
            .' COUNT(DISTINCT CASE WHEN client_id IS NOT NULL AND client_id <> \'\' THEN client_id END) AS unique_clients,'
            .' AVG('.$numericCase('dl').') AS dl_avg,'
            .' MAX('.$numericCase('dl').') AS dl_max,'
            .' AVG('.$numericCase('ul').') AS ul_avg,'
            .' MAX('.$numericCase('ul').') AS ul_max,'
            .' AVG('.$numericCase('ping').') AS ping_avg,'
            .' AVG('.$numericCase('jitter').') AS jitter_avg'
            .' FROM speedtest_users'.$where;
        $stmt = $pdo->prepare($sql);
        telemetryDbBindParams($stmt, $params);
        $stmt->execute();
        $aggregate = $stmt->fetch(PDO::FETCH_ASSOC);

        if (is_array($aggregate)) {
            $stats['unique_clients'] = (int) $aggregate['unique_clients'];
            $stats['dl_avg'] = round((float) $aggregate['dl_avg'], 2);
            $stats['dl_max'] = (float) $aggregate['dl_max'];
            $stats['ul_avg'] = round((float) $aggregate['ul_avg'], 2);
            $stats['ul_max'] = (float) $aggregate['ul_max'];
            $stats['ping_avg'] = round((float) $aggregate['ping_avg'], 2);
            $stats['jitter_avg'] = round((float) $aggregate['jitter_avg'], 2);
        }

        // per_day: last 30 calendar days (today included), days without data are omitted.
        $since = gmdate('Y-m-d 00:00:00', time() - (29 * 86400));
        $dayClauses = $clauses;
        $dayClauses[] = 'timestamp >= :f_since';
        $dayParams = $params;
        $dayParams[':f_since'] = $since;
        $sql = 'SELECT '.telemetryDbDayExpression($dbType).' AS day,'
            .' COUNT(*) AS cnt,'
            .' AVG('.$numericCase('dl').') AS dl_avg,'
            .' AVG('.$numericCase('ul').') AS ul_avg'
            .' FROM speedtest_users'.telemetryDbWhere($dayClauses)
            .' GROUP BY '.telemetryDbDayExpression($dbType).' ORDER BY day ASC';
        $stmt = $pdo->prepare($sql);
        telemetryDbBindParams($stmt, $dayParams);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (null === $row['day']) {
                continue;
            }
            $stats['per_day'][] = [
                'date' => (string) $row['day'],
                'count' => (int) $row['cnt'],
                'dl_avg' => round((float) $row['dl_avg'], 2),
                'ul_avg' => round((float) $row['ul_avg'], 2),
            ];
        }

        // top_isp: group by the raw ispinfo, then merge identical labels in
        // PHP (different runs against the same ISP can carry a different
        // hostname in the raw JSON).
        $ispClauses = $clauses;
        $ispClauses[] = 'ispinfo IS NOT NULL';
        $ispClauses[] = "ispinfo <> ''";
        $sql = 'SELECT ispinfo, COUNT(*) AS cnt FROM speedtest_users'
            .telemetryDbWhere($ispClauses)
            .' GROUP BY ispinfo ORDER BY cnt DESC'
            .telemetryDbLimitSql($dbType, 200, 0);
        $stmt = $pdo->prepare($sql);
        telemetryDbBindParams($stmt, $params);
        $stmt->execute();

        $byLabel = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $label = telemetryIspLabel($row['ispinfo']);
            if ('' === $label) {
                $label = '(unknown)';
            }
            if (!isset($byLabel[$label])) {
                $byLabel[$label] = 0;
            }
            $byLabel[$label] += (int) $row['cnt'];
        }
        arsort($byLabel);
        foreach (array_slice($byLabel, 0, 8, true) as $label => $count) {
            $stats['top_isp'][] = ['isp' => (string) $label, 'count' => (int) $count];
        }
    } catch (Exception $e) {
        // Return whatever was collected so far rather than a hard failure:
        // the admin panel can always render the zeroed shape.
        return $stats;
    }

    return $stats;
}

/**
 * Delete a single test result.
 *
 * $id is the raw numeric row id (NOT the obfuscated id_formatted form), which
 * is what the list API exposes.
 *
 * @param int|string $id
 *
 * @return int|false rows deleted, or false on database failure
 */
function deleteSpeedtestUserById($id)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    try {
        $stmt = $pdo->prepare('DELETE FROM speedtest_users WHERE id = :id');
        $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
        $stmt->execute();

        return (int) $stmt->rowCount();
    } catch (Exception $e) {
        return false;
    }
}

/**
 * Delete every test result older than $timestamp.
 *
 * @param string $timestamp "YYYY-MM-DD HH:MM:SS" in UTC
 *
 * @return int|false rows deleted, or false on database failure
 */
function purgeSpeedtestUsersBefore($timestamp)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    $timestamp = trim((string) $timestamp);
    if ('' === $timestamp) {
        return false;
    }

    try {
        $stmt = $pdo->prepare('DELETE FROM speedtest_users WHERE timestamp < :timestamp');
        $stmt->bindValue(':timestamp', $timestamp, PDO::PARAM_STR);
        $stmt->execute();

        return (int) $stmt->rowCount();
    } catch (Exception $e) {
        return false;
    }
}

/**
 * Delete every test result.
 *
 * @return int|false rows deleted, or false on database failure
 */
function purgeSpeedtestUsersAll()
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    try {
        return (int) $pdo->exec('DELETE FROM speedtest_users');
    } catch (Exception $e) {
        return false;
    }
}

/**
 * @return array|false
 */
function getLatestSpeedtestUsers()
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    require TELEMETRY_SETTINGS_FILE;
	
    try {
		$sql = 'SELECT ';
		
		if('mssql' === $db_type) {$sql .= ' TOP(100) ';}
		
		$sql .= ' id, timestamp, ip, ispinfo, ua, lang, dl, ul, ping, jitter, log, extra
            FROM speedtest_users
            ORDER BY timestamp DESC ';
			
		if('mssql' !== $db_type) {$sql .= ' LIMIT 100 ';}
		
        $stmt = $pdo->query($sql);

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as $i => $row) {
            $rows[$i]['id_formatted'] = $row['id'];
            if (isObfuscationEnabled()) {
                $rows[$i]['id_formatted'] = obfuscateId($row['id']).' (deobfuscated: '.$row['id'].')';
            }
        }
    } catch (Exception $e) {
        return false;
    }

    return $rows;
}
