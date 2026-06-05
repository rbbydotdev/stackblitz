'use strict';
require('../common');
const proto = Object.getPrototypeOf(process);
const ctor = process.constructor;
const v1 = ctor.prototype === proto;
const v2 = Object.getPrototypeOf(process) === ctor.prototype;
const v3 = Object.getPrototypeOf(ctor.prototype);
throw new Error(`vals:${v1},${v2},protoName=${v3&&v3.constructor&&v3.constructor.name}`);
