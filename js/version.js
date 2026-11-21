export const APP_VERSION = '0.6.0';
export const APP_TITLE = 'Thistle Notebook', FILE_EXT = 'tnote', FILE_FORMAT = 2; // 1: v0.1–0.3; 2: v0.4 (source tabs, file fingerprints)
// Thistle suite header written first in every saved file (suite convention shared with Thistle Plot / Thistle Flow)
export const fileHeader = kind => ({ app: APP_TITLE, format: FILE_FORMAT, appVersion: APP_VERSION, kind });
