'use strict';
require('../common');
const proto = Object.getPrototypeOf(process);
const d = Object.getOwnPropertyDescriptor(proto, 'constructor');
throw new Error(`has=${!!d},w=${d&&d.writable},c=${d&&d.configurable},e=${d&&d.enumerable},type=${d&&typeof d.value},name=${d&&d.value&&d.value.name}`);
