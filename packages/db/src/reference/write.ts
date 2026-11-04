import type pg from 'pg';
import { DomainError } from '@tradesoft/domain';

/**
 * Effective-dated membership writes shared by the reference API and `REFERENCE` imports, so both apply
 * BR-004 and the overlap rules identically. Callers hold the transaction; failures are `DomainError`s.
 */

export type MembershipWrite =
  | { outcome: 'ADDED'; closedSectorId: string | null }
  | { outcome: 'UPDATED'; before: { effectiveTo: string | null; weight?: string | null } }
  | { outcome: 'UNCHANGED' };

const windowCheck = (from: string, to: string | null) => {
  if (to !== null && to < from)
    throw new DomainError('MEMBERSHIP_WINDOW_INVALID', '`effectiveTo` is before `effectiveFrom`');
};

/**
 * Adds a sector membership period. The same (instrument, sector, start) again updates its end. Otherwise a
 * new period of the same sector kind closes the open period on the day before (BR-004); any other overlap
 * is refused.
 */
export async function addSectorMembership(
  c: pg.ClientBase,
  m: {
    instrumentId: string;
    sectorId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    source: string;
  },
): Promise<MembershipWrite> {
  windowCheck(m.effectiveFrom, m.effectiveTo);
  // Serialise membership writes per instrument so two overlapping periods cannot both pass the check.
  await c.query('select 1 from ref.instrument where id = $1 for update', [m.instrumentId]);
  const sector = (await c.query<{ kind: string }>('select kind from ref.sector where id = $1', [m.sectorId]))
    .rows[0];
  if (!sector) throw new DomainError('SECTOR_NOT_FOUND', 'No such sector');
  const { rows: overlapping } = await c.query<{
    sectorId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>(
    `select m.sector_id::text as "sectorId", m.effective_from::text as "effectiveFrom",
            m.effective_to::text as "effectiveTo"
       from ref.instrument_sector_membership m join ref.sector s on s.id = m.sector_id
      where m.instrument_id = $1 and s.kind = $2
        and daterange(m.effective_from, m.effective_to, '[]') && daterange($3::date, $4::date, '[]')`,
    [m.instrumentId, sector.kind, m.effectiveFrom, m.effectiveTo],
  );
  const same = overlapping.find((o) => o.sectorId === m.sectorId && o.effectiveFrom === m.effectiveFrom);
  if (same) {
    if (overlapping.length > 1)
      throw new DomainError('MEMBERSHIP_OVERLAP', 'The period overlaps another membership of the same kind');
    if (same.effectiveTo === m.effectiveTo) return { outcome: 'UNCHANGED' };
    await c.query(
      `update ref.instrument_sector_membership set effective_to = $4
        where instrument_id = $1 and sector_id = $2 and effective_from = $3`,
      [m.instrumentId, m.sectorId, m.effectiveFrom, m.effectiveTo],
    );
    return { outcome: 'UPDATED', before: { effectiveTo: same.effectiveTo } };
  }
  const previous = overlapping.length === 1 ? overlapping[0]! : null;
  const closable =
    previous !== null && previous.effectiveTo === null && previous.effectiveFrom < m.effectiveFrom;
  if (overlapping.length > 0 && !closable)
    throw new DomainError(
      'MEMBERSHIP_OVERLAP',
      'The period overlaps an existing membership of the same kind',
    );
  if (closable)
    await c.query(
      `update ref.instrument_sector_membership set effective_to = $3::date - 1
        where instrument_id = $1 and sector_id = $2 and effective_to is null`,
      [m.instrumentId, previous.sectorId, m.effectiveFrom],
    );
  await c.query(
    `insert into ref.instrument_sector_membership (instrument_id, sector_id, effective_from, effective_to, source)
     values ($1, $2, $3, $4, $5)`,
    [m.instrumentId, m.sectorId, m.effectiveFrom, m.effectiveTo, m.source],
  );
  return { outcome: 'ADDED', closedSectorId: closable ? previous.sectorId : null };
}

/** Adds an index constituent period; the same (index, member, start) again updates its end and weight. */
export async function addIndexMember(
  c: pg.ClientBase,
  m: {
    indexId: string;
    memberId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    weight: string | null;
  },
): Promise<MembershipWrite> {
  windowCheck(m.effectiveFrom, m.effectiveTo);
  const index = (
    await c.query<{ instrumentType: string }>(
      'select instrument_type as "instrumentType" from ref.instrument where id = $1 for update',
      [m.indexId],
    )
  ).rows[0];
  if (!index) throw new DomainError('INSTRUMENT_NOT_FOUND', 'No such index');
  if (index.instrumentType !== 'INDEX')
    throw new DomainError('VALIDATION_FAILED', 'The instrument is not an index');
  const { rows: overlapping } = await c.query<{
    effectiveFrom: string;
    effectiveTo: string | null;
    weight: string | null;
  }>(
    `select effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", weight::text as weight
       from ref.index_membership
      where index_instrument_id = $1 and member_instrument_id = $2
        and daterange(effective_from, effective_to, '[]') && daterange($3::date, $4::date, '[]')`,
    [m.indexId, m.memberId, m.effectiveFrom, m.effectiveTo],
  );
  const same = overlapping.find((o) => o.effectiveFrom === m.effectiveFrom);
  if (overlapping.length > (same ? 1 : 0))
    throw new DomainError('MEMBERSHIP_OVERLAP', 'The constituent already has an overlapping period');
  if (same) {
    const weight = (await c.query<{ w: string | null }>('select $1::numeric(9,6)::text as w', [m.weight]))
      .rows[0]!.w;
    if (same.effectiveTo === m.effectiveTo && same.weight === weight) return { outcome: 'UNCHANGED' };
    await c.query(
      `update ref.index_membership set effective_to = $4, weight = $5
        where index_instrument_id = $1 and member_instrument_id = $2 and effective_from = $3`,
      [m.indexId, m.memberId, m.effectiveFrom, m.effectiveTo, m.weight],
    );
    return { outcome: 'UPDATED', before: { effectiveTo: same.effectiveTo, weight: same.weight } };
  }
  await c.query(
    `insert into ref.index_membership (index_instrument_id, member_instrument_id, effective_from, effective_to, weight)
     values ($1, $2, $3, $4, $5)`,
    [m.indexId, m.memberId, m.effectiveFrom, m.effectiveTo, m.weight],
  );
  return { outcome: 'ADDED', closedSectorId: null };
}
