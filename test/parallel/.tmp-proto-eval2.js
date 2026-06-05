'use strict';
require('../common');
const EE = require('events');
const proto = Object.getPrototypeOf(process);
const a = proto instanceof EE;
const b = process instanceof process.constructor;
const c = proto instanceof EE;
throw new Error(`vals:${a},${b},${c}`);
