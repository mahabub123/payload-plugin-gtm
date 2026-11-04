import type { CollectionConfig } from 'payload'

/**
 * Internal lease table. A lock is a row with a unique `key`, so acquiring one is an
 * INSERT that the database itself rejects when the key is taken. This works the same
 * on every Payload database adapter and across any number of server instances.
 */
export const buildGtmLocksCollection = (slug: string): CollectionConfig => ({
  slug,
  access: {
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  admin: { hidden: true },
  fields: [
    { name: 'key', type: 'text', index: true, required: true, unique: true },
    { name: 'owner', type: 'text', required: true },
    { name: 'expiresAt', type: 'date', required: true },
  ],
  graphQL: false,
  labels: { plural: 'GTM locks', singular: 'GTM lock' },
})
