'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BG_FILE  = path.join(DATA_DIR, 'backgrounds.json');

function getBackgrounds() {
  try {
    return JSON.parse(fs.readFileSync(BG_FILE, 'utf8'));
  } catch {
    return { profit: null, loss: null };
  }
}

function setBackground(type, filePath) {
  const bgs = getBackgrounds();
  bgs[type] = filePath;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BG_FILE, JSON.stringify(bgs, null, 2));
}

module.exports = { getBackgrounds, setBackground };
