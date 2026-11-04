import type { CollectionConfig } from 'payload'

import type { ResolvedGtmPluginOptions } from '../types.js'

import { invalidateIgnoreCache } from '../lib/publicConfig.js'
import { EVENT_NAME_RE } from '../shared/normalize.js'

const isAuthenticated = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)

/** Fields written by discovery; read-only in the admin (INV-02). */
const discoveryOwned = { readOnly: true } as const

export const buildGtmEventsCollection = (options: ResolvedGtmPluginOptions): CollectionConfig => {
  const collection: CollectionConfig = {
    slug: options.collectionSlug,
    access: {
      // Events are only created by discovery (Local API with overrideAccess) — never via REST.
      create: () => false,
      delete: options.access.delete ?? isAuthenticated,
      read: options.access.read ?? isAuthenticated,
      update: options.access.update ?? isAuthenticated,
    },
    admin: {
      components: options.disabled
        ? undefined
        : {
            beforeListTable: [
              {
                clientProps: {
                  basePath: options.basePath,
                  globalSlug: options.globalSlug,
                },
                path: 'payload-plugin-gtm/client#GtmScanPanel',
              },
            ],
          },
      defaultColumns: ['eventName', 'status', 'sources', 'occurrences', 'lastSeenAt'],
      description:
        'Every dataLayer event discovered on your site. Discovery fills the read-only fields; you own status, description, owner and notes.',
      group: options.adminGroup,
      listSearchableFields: ['eventName', 'description'],
      useAsTitle: 'eventName',
    },
    defaultSort: '-lastSeenAt',
    fields: [
      {
        name: 'eventName',
        type: 'text',
        index: true,
        required: true,
        unique: true,
        validate: (value: null | string | undefined) =>
          typeof value === 'string' && EVENT_NAME_RE.test(value)
            ? true
            : 'Event names may contain letters, digits, spaces and _ . : - / (max 100).',
      },
      {
        type: 'row',
        fields: [
          {
            name: 'status',
            type: 'select',
            defaultValue: 'discovered',
            index: true,
            options: [
              { label: 'Discovered', value: 'discovered' },
              { label: 'Approved', value: 'approved' },
              { label: 'Deprecated', value: 'deprecated' },
              { label: 'Ignored', value: 'ignored' },
            ],
            required: true,
          },
          { name: 'owner', type: 'text' },
        ],
      },
      { name: 'description', type: 'textarea' },
      {
        type: 'tabs',
        tabs: [
          {
            fields: [
              {
                name: 'parameters',
                type: 'array',
                admin: { ...discoveryOwned, initCollapsed: true },
                fields: [
                  {
                    type: 'row',
                    fields: [
                      { name: 'path', type: 'text', admin: discoveryOwned, required: true },
                      {
                        name: 'types',
                        type: 'select',
                        admin: discoveryOwned,
                        hasMany: true,
                        options: ['string', 'number', 'boolean', 'object', 'array', 'null'],
                      },
                    ],
                  },
                  { name: 'example', type: 'text', admin: discoveryOwned },
                  { name: 'description', type: 'text' },
                ],
              },
            ],
            label: 'Parameters',
          },
          {
            fields: [
              {
                name: 'firesTags',
                type: 'array',
                admin: {
                  ...discoveryOwned,
                  description: 'Tags in the published GTM container triggered by this event.',
                },
                fields: [
                  {
                    type: 'row',
                    fields: [
                      { name: 'tagId', type: 'text', admin: discoveryOwned },
                      { name: 'tagType', type: 'text', admin: discoveryOwned },
                      { name: 'ga4EventName', type: 'text', admin: discoveryOwned },
                    ],
                  },
                ],
              },
              {
                name: 'pages',
                type: 'array',
                admin: { ...discoveryOwned, description: 'Up to 25 page paths where it was seen.' },
                fields: [{ name: 'path', type: 'text', admin: discoveryOwned }],
              },
            ],
            label: 'Where it fires',
          },
          {
            fields: [{ name: 'notes', type: 'textarea' }],
            label: 'Notes',
          },
        ],
      },
      {
        name: 'sources',
        type: 'select',
        admin: { ...discoveryOwned, position: 'sidebar' },
        hasMany: true,
        options: [
          { label: 'Runtime (browser)', value: 'runtime' },
          { label: 'GTM container', value: 'container' },
          { label: 'Page crawl', value: 'crawl' },
        ],
      },
      {
        name: 'matchType',
        type: 'select',
        admin: {
          ...discoveryOwned,
          description: 'How the GTM trigger matches the event name.',
          position: 'sidebar',
        },
        defaultValue: 'exact',
        options: ['exact', 'regex', 'startsWith', 'endsWith', 'contains'],
      },
      {
        name: 'isBuiltIn',
        type: 'checkbox',
        admin: {
          ...discoveryOwned,
          description: 'GTM internal event (gtm.*)',
          position: 'sidebar',
        },
        defaultValue: false,
      },
      {
        name: 'occurrences',
        type: 'number',
        admin: {
          ...discoveryOwned,
          description: 'Approximate, deduplicated observations. Use GA4 for real counts.',
          position: 'sidebar',
        },
        defaultValue: 0,
      },
      {
        name: 'firstSeenAt',
        type: 'date',
        admin: { ...discoveryOwned, date: { pickerAppearance: 'dayAndTime' }, position: 'sidebar' },
      },
      {
        name: 'lastSeenAt',
        type: 'date',
        admin: { ...discoveryOwned, date: { pickerAppearance: 'dayAndTime' }, position: 'sidebar' },
        index: true,
      },
    ],
    hooks: {
      afterChange: [
        ({ doc, previousDoc }) => {
          if (doc?.status !== previousDoc?.status) {
            invalidateIgnoreCache()
          }
        },
      ],
      afterDelete: [() => invalidateIgnoreCache()],
    },
    labels: { plural: 'Data Layer Events', singular: 'Data Layer Event' },
  }

  return options.overrideCollection ? options.overrideCollection(collection) : collection
}
