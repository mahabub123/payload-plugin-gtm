import type { GlobalConfig } from 'payload'

import type { ResolvedGtmPluginOptions } from '../types.js'

import { invalidateSettingsCache } from '../lib/settings.js'

export const CONTAINER_ID_RE = /^GTM-[A-Z0-9]{4,12}$/

const validateEnvToken = (value: null | string | undefined) =>
  !value || /^[\w-]{1,100}$/.test(value) ? true : 'Only letters, digits, _ and - are allowed'

const isAuthenticated = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)

export const buildGtmSettingsGlobal = (options: ResolvedGtmPluginOptions): GlobalConfig => {
  const global: GlobalConfig = {
    slug: options.globalSlug,
    access: {
      read: options.access.read ?? isAuthenticated,
      update: options.access.updateSettings ?? options.access.update ?? isAuthenticated,
    },
    admin: { group: options.adminGroup },
    fields: [
      {
        type: 'row',
        fields: [
          {
            name: 'enabled',
            type: 'checkbox',
            admin: { description: 'Load GTM on the website.' },
            defaultValue: true,
          },
          {
            name: 'containerId',
            type: 'text',
            admin: {
              description: options.containerId
                ? `Leave empty to use the code default (${options.containerId}).`
                : 'e.g. GTM-ABC1234',
            },
            validate: (value: null | string | undefined) =>
              !value || CONTAINER_ID_RE.test(value) ? true : 'Must look like GTM-XXXXXXX',
          },
          {
            name: 'dataLayerName',
            type: 'text',
            defaultValue: 'dataLayer',
            validate: (value: null | string | undefined) =>
              !value || /^[A-Z_$][\w$]{0,49}$/i.test(value)
                ? true
                : 'Must be a valid JS identifier',
          },
        ],
      },
      {
        name: 'environment',
        type: 'group',
        admin: {
          description:
            'Optional GTM environment (Admin → Environments → Get snippet: gtm_auth / gtm_preview).',
        },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'auth', type: 'text', label: 'gtm_auth', validate: validateEnvToken },
              { name: 'preview', type: 'text', label: 'gtm_preview', validate: validateEnvToken },
            ],
          },
        ],
      },
      {
        name: 'discovery',
        type: 'group',
        admin: {
          description:
            'Runtime discovery: the browser hook reports event names and parameter shapes (not values by default).',
        },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'enabled', type: 'checkbox', defaultValue: true },
              {
                name: 'sampleRate',
                type: 'number',
                admin: { description: 'Fraction of sessions that report (0–1).', step: 0.05 },
                defaultValue: 1,
                max: 1,
                min: 0,
              },
            ],
          },
          {
            type: 'row',
            fields: [
              {
                name: 'includeBuiltInEvents',
                type: 'checkbox',
                admin: { description: 'Also record gtm.js, gtm.dom, gtm.click…' },
                defaultValue: false,
              },
              {
                name: 'captureExamples',
                type: 'checkbox',
                admin: {
                  description:
                    'Store one redacted example value per parameter. Off by default for privacy.',
                },
                defaultValue: false,
              },
            ],
          },
          {
            name: 'allowedOrigins',
            type: 'text',
            admin: {
              description:
                'Origins allowed to report (e.g. https://www.example.com). Empty = same origin as the Payload server URL, or any origin if serverURL is unset.',
            },
            hasMany: true,
          },
        ],
      },
      {
        name: 'crawl',
        type: 'group',
        admin: { description: 'Static discovery: crawl same-origin pages and scripts.' },
        fields: [
          {
            name: 'siteUrl',
            type: 'text',
            admin: { description: 'e.g. https://www.example.com' },
            validate: (value: null | string | undefined) => {
              if (!value) {
                return true
              }
              try {
                const url = new URL(value)
                return url.protocol === 'https:' || url.protocol === 'http:'
                  ? true
                  : 'Must be http(s)'
              } catch {
                return 'Must be a valid URL'
              }
            },
          },
          { name: 'useSitemap', type: 'checkbox', defaultValue: true },
          {
            name: 'urls',
            type: 'text',
            admin: { description: 'Extra paths or same-origin URLs to crawl.' },
            hasMany: true,
          },
        ],
      },
      {
        name: 'lastScan',
        type: 'json',
        admin: { description: 'Summary of the last container scan / crawl.', readOnly: true },
      },
    ],
    hooks: {
      afterChange: [
        () => {
          invalidateSettingsCache()
        },
      ],
    },
    label: 'GTM Settings',
  }

  return options.overrideGlobal ? options.overrideGlobal(global) : global
}
