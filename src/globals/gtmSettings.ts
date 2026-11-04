import type { Field, GlobalConfig } from 'payload'

import type { ResolvedGtmPluginOptions } from '../types.js'

import { isAdminUser } from '../lib/access.js'
import { invalidateSettingsCache } from '../lib/settings.js'
import { CONTAINER_ID_RE, MEASUREMENT_ID_RE, normalizeTagId, REGION_RE } from '../shared/ids.js'

export { CONTAINER_ID_RE, MEASUREMENT_ID_RE }

const consentSelect = (name: string, label: string): Field => ({
  name,
  type: 'select',
  defaultValue: 'denied',
  label,
  options: [
    { label: 'Denied', value: 'denied' },
    { label: 'Granted', value: 'granted' },
  ],
})

/** Trim + uppercase pasted IDs before validation (` gtm-abc123 ` → `GTM-ABC123`). */
const normalizeIdHook = ({ value }: { value?: unknown }) => normalizeTagId(value) ?? null

const validateEnvToken = (value: null | string | undefined) =>
  !value || /^[\w-]{1,100}$/.test(value) ? true : 'Only letters, digits, _ and - are allowed'

export const buildGtmSettingsGlobal = (options: ResolvedGtmPluginOptions): GlobalConfig => {
  const global: GlobalConfig = {
    slug: options.globalSlug,
    access: {
      read: options.access.read ?? isAdminUser,
      update: options.access.updateSettings ?? options.access.update ?? isAdminUser,
    },
    admin: { group: options.adminGroup },
    fields: [
      {
        type: 'row',
        fields: [
          {
            name: 'enabled',
            type: 'checkbox',
            admin: { description: 'Load GTM / Google Analytics on the website.' },
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
            hooks: { beforeValidate: [normalizeIdHook] },
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
        name: 'analytics',
        type: 'group',
        admin: {
          description:
            'Google Analytics 4 via gtag.js. Works with or without a GTM container. If your GTM container already fires a GA4 tag for this ID, leave this empty, or page views are counted twice.',
        },
        fields: [
          {
            type: 'row',
            fields: [
              {
                name: 'measurementId',
                type: 'text',
                admin: {
                  description: options.measurementId
                    ? `Leave empty to use the code default (${options.measurementId}).`
                    : 'e.g. G-ABC123XYZ9',
                },
                hooks: { beforeValidate: [normalizeIdHook] },
                label: 'Measurement ID',
                validate: (value: null | string | undefined) =>
                  !value || MEASUREMENT_ID_RE.test(value) ? true : 'Must look like G-XXXXXXXXXX',
              },
              {
                name: 'sendPageView',
                type: 'checkbox',
                admin: {
                  description:
                    'Send the initial page_view. SPA navigations are tracked by GA4 enhanced measurement.',
                },
                defaultValue: true,
              },
              {
                name: 'debugMode',
                type: 'checkbox',
                admin: { description: 'Show hits in GA4 DebugView. Turn off in production.' },
                defaultValue: false,
              },
            ],
          },
        ],
        label: 'Google Analytics 4',
      },
      {
        name: 'consent',
        type: 'group',
        admin: {
          description:
            'Google Consent Mode v2. When on, these defaults are sent before GTM / GA4 load, and your consent banner calls updateConsent() when the visitor decides. Required for EEA/UK traffic. Turning this on with "denied" defaults stops GA4 cookies until consent is granted.',
        },
        fields: [
          {
            name: 'enabled',
            type: 'checkbox',
            defaultValue: false,
            label: 'Send consent defaults',
          },
          {
            type: 'row',
            admin: { condition: (_, sibling) => Boolean(sibling?.enabled) },
            fields: [
              consentSelect('analyticsStorage', 'analytics_storage'),
              consentSelect('adStorage', 'ad_storage'),
              consentSelect('adUserData', 'ad_user_data'),
              consentSelect('adPersonalization', 'ad_personalization'),
            ],
          },
          {
            type: 'row',
            admin: { condition: (_, sibling) => Boolean(sibling?.enabled) },
            fields: [
              {
                name: 'waitForUpdateMs',
                type: 'number',
                admin: {
                  description: 'How long tags wait for the banner to send an update (ms).',
                  step: 100,
                },
                defaultValue: 500,
                max: 10_000,
                min: 0,
              },
              {
                name: 'regions',
                type: 'text',
                admin: {
                  description:
                    'Apply these defaults only in these ISO regions (e.g. DE, FR, US-CA). Empty = everywhere.',
                },
                hasMany: true,
                hooks: {
                  beforeValidate: [
                    ({ value }) =>
                      Array.isArray(value)
                        ? value.map((r) => (typeof r === 'string' ? r.trim().toUpperCase() : r))
                        : value,
                  ],
                },
                validate: (value: null | string[] | undefined) =>
                  !value || value.every((r) => REGION_RE.test(r))
                    ? true
                    : 'Use ISO codes like DE or US-CA',
              },
            ],
          },
        ],
        label: 'Consent Mode',
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
