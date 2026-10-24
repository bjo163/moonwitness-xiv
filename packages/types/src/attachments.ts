/** Product limit for every application-managed file, expressed in binary mebibytes. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** JSON/Base64 transport cap; decoded file content is still limited to MAX_ATTACHMENT_BYTES. */
export const MAX_ATTACHMENT_REQUEST_BYTES = 15 * 1024 * 1024;
