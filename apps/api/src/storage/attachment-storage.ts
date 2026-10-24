import {
  LocalFileAttachmentStorage,
  S3AttachmentStorage,
  type AttachmentStorage,
} from '@moonwitness/orm-storage';
import { config } from '../config/env.js';

export function createAttachmentStorage(): AttachmentStorage {
  if (config.attachmentStorageDriver === 'local') {
    return new LocalFileAttachmentStorage(config.attachmentStorageDirectory);
  }
  if (!config.s3Storage) throw new Error('S3-compatible storage configuration is missing');
  return new S3AttachmentStorage(config.s3Storage);
}
