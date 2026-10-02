function modernStartButton(page) {
  return page.locator("#start-button");
}

function stabilityStartButton(page) {
  return page.locator("#startBtn");
}

module.exports = {
  modernStartButton,
  stabilityStartButton
};
