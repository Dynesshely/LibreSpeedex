# LibreSpeedex

No Flash, No Java, No Websocket, No Bullshit.

A very lightweight speed test implemented in Javascript, using XMLHttpRequest
and Web Workers, wearing a terminal / CRT interface.

> **LibreSpeedex is a fork of [LibreSpeed](https://github.com/librespeed/speedtest)**
> by Federico Dossena. The test engine (`speedtest.js`, `speedtest_worker.js`,
> the PHP backend, the stability worker and the results/telemetry UI) is
> upstream code and keeps its attribution; this fork contributes the interface:
> the palette, the terminal / CRT screen, the console layout and the realtime
> plot. Licensed under LGPL-3.0-or-later, same as upstream.

## Try it

This fork is not published to any registry: run it yourself (see
[Installation](#installation)), or try the upstream project's public instance at
[librespeed.org](https://librespeed.org).

## Compatibility

All modern browsers are supported: IE11, latest Edge, latest Chrome, latest Firefox, latest Safari.
Works with mobile versions too.

## Features

* Download
* Upload
* Ping
* Jitter
* IP Address, ISP, distance from server (optional)
* Telemetry (optional)
* Results sharing (optional)
* Multiple Points of Test (optional)
* Connection stability test with latency charting, loss tracking, threshold alerts, and CSV export

![Screenrecording of a running Speedtest](https://speedtest.fdossena.com/mpot_v7.gif)

## Server requirements

* A reasonably fast web server with Apache 2 (nginx, IIS also supported)
* PHP 5.4 or newer (other backends also available)
* MariaDB or MySQL database to store test results (optional, Microsoft SQL Server, PostgreSQL and SQLite also supported)
* A fast! internet connection

## Installation

Assuming you have PHP and a web server installed, the installation steps are quite simple.

1. Download the source code and extract it
1. Copy the project files to your web server's shared folder (ie. `/var/www/html/speedtest` for Apache), keeping the layout as it is in the repository. The modern UI loads its assets from `frontend/`, so that directory is copied as a whole rather than unpacked.
1. Optionally, copy the results folder too, and set up the database using the config file in it.
1. Be sure your permissions allow read and execute access where needed.
1. Visit YOURSITE/speedtest/index.html and voila!

### Installation Video

This video shows the installation process of a standalone LibreSpeed server: [Quick start installation guide for Debian 12](https://fdossena.com/?p=speedtest/quickstart_deb12.frag)

More videos will be added later.

## Android app

A template to build an Android client for your LibreSpeed installation is available [here](https://github.com/librespeed/speedtest-android).

## CLI client

A command line client is available [here](https://github.com/librespeed/speedtest-cli).

## .NET client

A .NET client library is available in the [`LibreSpeed.NET`](https://github.com/Memphizzz/LibreSpeed.NET) repo ([NuGet](https://www.nuget.org/packages/LibreSpeed.NET)), maintained by [MemphiZ](https://github.com/Memphizzz).

## Development

If you want to contribute or develop with LibreSpeedex, see [DEVELOPMENT.md](DEVELOPMENT.md) for information about using npm for development tasks, linting, and formatting.

## User interface

LibreSpeedex ships two pages sharing one design language. `index.html` is the speed test: a
phosphor screen with scanlines, a pixelated activity backdrop, twin speed gauges
and a realtime throughput plot (x: elapsed time, y: Mbit/s) drawn while a test
runs. It is built with Tailwind utilities compiled ahead of time into
`frontend/styling/tailwind.css`; see [DEVELOPMENT.md](DEVELOPMENT.md) for the
build step and how to reskin it.

Docker deployments can customise the page with the `TITLE`, `TAGLINE` and
`GDPR_EMAIL` environment variables, see [doc_docker.md](doc_docker.md).

## Stability test

`stability.html` is a connection stability test, linked from the page footer. It repeatedly measures ping over a selected duration and reports current, average, minimum, maximum, jitter, and failed request percentage values with a live chart.

The stability test can target the local backend, one of the configured multiple points of test, or built-in external targets such as Google, Cloudflare, and Apple. It also supports optional latency threshold alerts and CSV export of the collected samples. Docker deployments copy `stability.html` and `stability_worker.js` into the web root and reuse the same server list configuration as the main UI.

## Docker

A docker image is available on [GitHub](https://github.com/librespeed/speedtest/pkgs/container/speedtest), check our [docker documentation](doc_docker.md) for more info about it.
The image is built every week to include an updated version of the ipinfo-DB used for ISP detection. Also this ensures, that the latest security patches in PHP are installed. Therefore we recommend to use the `latest` image.

## Go backend

A Go implementation is available in the [`speedtest-go`](https://github.com/librespeed/speedtest-go) repo, maintained by [Maddie Zhan](https://github.com/maddie).

## Rust backend

A Rust implementation is available in the [`speedtest-rust`](https://github.com/librespeed/speedtest-rust) repo, maintained by [Sudo Dios](https://github.com/sudodios).

## Node.js backend

A partial Node.js implementation is available in the `node` branch, developed by [dunklesToast](https://github.com/dunklesToast). It's not recommended to use at the moment.

## Donate

[![Donate with Liberapay](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/fdossena/donate)
[Donate with PayPal](https://www.paypal.me/sineisochronic)

## License

Copyright (C) 2016-2024 Federico Dossena

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/lgpl>.
