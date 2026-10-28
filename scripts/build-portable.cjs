'use strict';
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
const { patchPortableTemplate } = require('./portable-template.cjs');

const original = NsisTarget.prototype.computeFinalScript;
NsisTarget.prototype.computeFinalScript = function (source, ...args) {
  return original.call(this, this.name === 'portable' ? patchPortableTemplate(source) : source, ...args);
};

build({ projectDir: path.resolve(__dirname, '..'), targets: Platform.WINDOWS.createTarget('portable', Arch.x64), publish: 'never' })
  .catch(error => { console.error(error); process.exitCode = 1; });
