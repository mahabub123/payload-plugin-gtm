import type { PayloadRequest } from 'payload'

/**
 * Default access for every plugin operation: a logged-in user from the ADMIN user
 * collection (`config.admin.user`). Users of other auth collections — storefront
 * customers, members, API users — are refused, because anyone who can edit these
 * settings can load arbitrary JavaScript (a GTM container) on every page of the site.
 *
 * If your admin collection also holds non-admin roles, pass `access` overrides.
 */
export const isAdminUser = ({ req }: { req: PayloadRequest }): boolean => {
  const user = req.user as ({ collection?: string } & Record<string, unknown>) | null | undefined
  if (!user) {
    return false
  }
  const adminSlug = req.payload?.config?.admin?.user
  return !adminSlug || user.collection === adminSlug
}
