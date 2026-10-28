'use strict';

const fs = require('node:fs');

// Keep the last complete file until the replacement is ready.
function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(temporary, file);
}

module.exports = { writeJson };
