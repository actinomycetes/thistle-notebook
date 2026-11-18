export const APP_VERSION = '0.2.2';
export const APP_TITLE = 'Thistle Notebook', FILE_EXT = 'tnote', FILE_FORMAT = 1;
// Thistle suite header written first in every saved file (suite convention shared with Thistle Plot / Thistle Flow)
export const fileHeader = kind => ({ app: APP_TITLE, format: FILE_FORMAT, appVersion: APP_VERSION, kind });
