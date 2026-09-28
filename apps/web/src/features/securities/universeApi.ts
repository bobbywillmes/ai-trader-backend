import { apiRequest, getAdminToken, getApiUrl } from '../../lib/api';

export type ImportTiming = { kind: 'immediate' } | { kind: 'scheduled'; membershipEffectiveDate: string };
export type ImportPlan = {
  applied: boolean; timing: ImportTiming; effectiveDate: string; inputSecurityCount: number;
  suppliedColumns: string[]; omittedColumns: string[]; newSecurities: { symbol: string; name?: string }[];
  metadataChanges: { symbol: string; before: Record<string, string | null>; after: Record<string, string | null> }[];
  membershipAdditions: { symbol: string; code: string }[];
  membershipRemovals: { symbol: string; code: string }[];
  membershipDeletions: { symbol: string; code: string }[];
  membershipReopens: { symbol: string; code: string }[];
  unchangedMembershipValues: { symbol: string; code: string; value: string }[];
  conflicts: string[]; missingUniverses: string[]; currentBroadMemberCount: number; resultingBroadMemberCount: number;
  universeCounts: { code: string; before: number; after: number }[]; breadthMembershipChanged: boolean;
};
export type FreezePlan = { applied: boolean; alreadyExists: boolean; revisionId: number | null; effectiveDate: string; memberCount: number; constituentHash: string };
export type ImportInput = { csv: string; timing: ImportTiming };

export function requestImport(input: ImportInput, apply: boolean) {
  return apiRequest<ImportPlan>(`/api/securities/universe-import/${apply ? 'apply' : 'preview'}`, { method: 'POST', token: getAdminToken(), body: input });
}
export function requestFreeze(effectiveDate: string, apply: boolean) {
  return apiRequest<FreezePlan>(`/api/securities/breadth-revision/${apply ? 'freeze' : 'preview'}`, { method: 'POST', token: getAdminToken(), body: { effectiveDate } });
}
export async function downloadSecurityCsv(kind: 'universe-snapshot' | 'security-catalog') {
  const response = await fetch(getApiUrl(`/api/securities/exports/${kind}`), { headers: { Authorization: `Bearer ${getAdminToken() ?? ''}` } });
  if (!response.ok) throw new Error(`Export failed (${response.status}).`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `${kind}.csv`;
  document.body.appendChild(link);
  link.click(); link.remove(); URL.revokeObjectURL(url);
}
