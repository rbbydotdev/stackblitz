'use strict';
require('../common');
const proto = Object.getPrototypeOf(process);
const ctor = process.constructor;
const d = Object.getOwnPropertyDescriptor(ctor, 'prototype');
throw new Error(`w=${d&&d.writable},c=${d&&d.configurable},e=${d&&d.enumerable},same=${d&&d.value===proto},name=${ctor.name}`);
