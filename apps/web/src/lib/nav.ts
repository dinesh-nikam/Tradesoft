// The navigation of the product brief, each item behind the permission its API requires (00 §4.2). The SPA hides
// what a user cannot use; the API still enforces every permission (05 §15).
export interface NavItem {
  path: string;
  label: string;
  permission: string;
  /** The implementation phase that delivers the screen (08 §3). */
  phase: number;
}

export const NAV: readonly NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', permission: 'dashboard:read', phase: 13 },
  { path: '/markets', label: 'Markets', permission: 'instrument:read', phase: 9 },
  { path: '/charts', label: 'Charts', permission: 'chart:read', phase: 9 },
  { path: '/renko', label: 'Renko', permission: 'chart:read', phase: 9 },
  { path: '/sectors', label: 'Sectors', permission: 'sector:read', phase: 10 },
  { path: '/breadth', label: 'Breadth', permission: 'breadth:read', phase: 10 },
  { path: '/rs-matrix', label: 'RS Matrix', permission: 'rs:read', phase: 11 },
  { path: '/scanners', label: 'Scanners', permission: 'scanner:read', phase: 12 },
  { path: '/data', label: 'Data Management', permission: 'instrument:write', phase: 4 },
  { path: '/imports', label: 'Imports', permission: 'ingestion:read', phase: 5 },
  { path: '/settings', label: 'Settings', permission: 'settings:read', phase: 14 },
  { path: '/admin/users', label: 'Users', permission: 'user:read', phase: 3 },
  { path: '/admin/jobs', label: 'Jobs', permission: 'job:read', phase: 5 },
  { path: '/admin/audit', label: 'Audit', permission: 'audit:read', phase: 14 },
];

export const visibleNav = (perms: ReadonlySet<string>): NavItem[] =>
  NAV.filter((i) => perms.has(i.permission));
