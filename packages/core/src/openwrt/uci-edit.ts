// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { uciList, type UciChange, type UciConfig, type UciSection, type UciValue } from './uci.ts';

/**
 * Changes as the panel collects them before review, LuCI's way: edits of
 * one section become one change, a section added and then removed leaves
 * nothing, and an edit back to what the router has drops out. The order of
 * sections, if changed, comes last, after the sections it may name are added.
 */
export function addUciChange(base: UciConfig, changes: readonly UciChange[], change: UciChange): UciChange[] {
  let list = changes.filter((existing) => existing.kind !== 'order');
  let order = changes.find((existing): existing is Extract<UciChange, { kind: 'order' }> => existing.kind === 'order');
  const added = (section: string) => list.find((existing): existing is Extract<UciChange, { kind: 'add' }> => existing.kind === 'add' && existing.ref === section);
  const original = (section: string) => base.sections.find((candidate) => candidate.name === section);

  switch (change.kind) {
    case 'add':
      list.push({ ...change, values: { ...change.values } });
      break;
    case 'set': {
      const add = added(change.section);
      if (add !== undefined) {
        list = list.map((existing) => (existing === add ? { ...add, values: { ...add.values, ...change.values } } : existing));
        break;
      }
      const before = original(change.section)?.options ?? {};
      // What the router has already is no change.
      const values = Object.fromEntries(Object.entries(change.values).filter(([option, value]) => !sameValue(before[option], value)));
      const set = list.find((existing) => existing.kind === 'set' && existing.section === change.section) as Extract<UciChange, { kind: 'set' }> | undefined;
      const merged = { ...(set?.values ?? {}), ...values };
      // An option set to what the router has drops out of an earlier set too.
      for (const option of Object.keys(change.values)) if (!(option in values)) delete merged[option];
      list = list.filter((existing) => existing !== set);
      list = list.flatMap((existing) => {
        if (existing.kind !== 'unset' || existing.section !== change.section) return [existing];
        const options = existing.options.filter((option) => !(option in change.values));
        return options.length === 0 ? [] : [{ ...existing, options }];
      });
      if (Object.keys(merged).length > 0) list.push({ kind: 'set', section: change.section, values: merged });
      break;
    }
    case 'unset': {
      const add = added(change.section);
      if (add !== undefined) {
        const values = { ...add.values };
        for (const option of change.options) delete values[option];
        list = list.map((existing) => (existing === add ? { ...add, values } : existing));
        break;
      }
      list = list.flatMap((existing) => {
        if (existing.kind !== 'set' || existing.section !== change.section) return [existing];
        const values = Object.fromEntries(Object.entries(existing.values).filter(([option]) => !change.options.includes(option)));
        return Object.keys(values).length === 0 ? [] : [{ ...existing, values }];
      });
      // Only what the router has can be removed.
      const present = change.options.filter((option) => option in (original(change.section)?.options ?? {}));
      const unset = list.find((existing) => existing.kind === 'unset' && existing.section === change.section) as Extract<UciChange, { kind: 'unset' }> | undefined;
      const options = [...new Set([...(unset?.options ?? []), ...present])];
      list = list.filter((existing) => existing !== unset);
      if (options.length > 0) list.push({ kind: 'unset', section: change.section, options });
      break;
    }
    case 'delete': {
      const add = added(change.section);
      list = list.filter((existing) => existing !== add && !('section' in existing && existing.section === change.section));
      if (add === undefined) list.push(change);
      if (order !== undefined) order = { ...order, sections: order.sections.filter((section) => section !== change.section) };
      break;
    }
    case 'order':
      order = change;
      break;
  }
  return order === undefined ? list : [...list, order];
}

/**
 * The configuration as it will be once the changes are applied, for the
 * panel to show before review. Added sections take their ref as their name,
 * and come last, as rpcd adds them.
 */
export function previewUci(base: UciConfig, changes: readonly UciChange[]): UciConfig {
  let sections: UciSection[] = base.sections.map((section) => ({ ...section, options: { ...section.options } }));
  let fresh = 0;
  for (const change of changes) {
    switch (change.kind) {
      case 'add':
        fresh += 1;
        sections.push({ name: change.name ?? change.ref ?? `new-${fresh}`, type: change.type, anonymous: change.name === undefined, index: sections.length, options: { ...change.values } });
        break;
      case 'set': {
        const section = sections.find((candidate) => candidate.name === change.section);
        if (section !== undefined) Object.assign(section.options, change.values);
        break;
      }
      case 'unset': {
        const section = sections.find((candidate) => candidate.name === change.section);
        if (section !== undefined) for (const option of change.options) delete section.options[option];
        break;
      }
      case 'delete':
        sections = sections.filter((section) => section.name !== change.section);
        break;
      case 'order': {
        // rpcd puts the sections named at positions 0, 1, ...; the rest follow in their order.
        const named = change.sections.map((name) => sections.find((section) => section.name === name)).filter((section) => section !== undefined);
        sections = [...named, ...sections.filter((section) => !named.includes(section))];
        break;
      }
    }
  }
  return { name: base.name, sections: sections.map((section, index) => ({ ...section, index })) };
}

/**
 * The change that gives a section these options, where undefined removes one:
 * an add for a new section, else a set of what differs and an unset of what
 * goes. Options not named stay as they are.
 */
export function sectionChanges(
  section: UciSection | undefined,
  type: string,
  wanted: Record<string, UciValue | undefined>,
  ref: string,
): UciChange[] {
  const defined = Object.fromEntries(Object.entries(wanted).filter((entry): entry is [string, UciValue] => entry[1] !== undefined));
  if (section === undefined) return [{ kind: 'add', type, ref, values: defined }];
  const values = Object.fromEntries(Object.entries(defined).filter(([option, value]) => !sameValue(section.options[option], value)));
  const removed = Object.entries(wanted)
    .filter(([option, value]) => value === undefined && option in section.options)
    .map(([option]) => option);
  return [
    ...(Object.keys(values).length > 0 ? [{ kind: 'set' as const, section: section.name, values }] : []),
    ...(removed.length > 0 ? [{ kind: 'unset' as const, section: section.name, options: removed }] : []),
  ];
}

/**
 * The order that moves the sections of one type into the order given,
 * leaving every other section where it is: rpcd's order takes the place of
 * each section in the whole file, so the whole file is named.
 */
export function typeOrder(config: UciConfig, type: string, ordered: readonly string[]): UciChange {
  const queue = [...ordered];
  const sections = config.sections.map((section) => (section.type === type ? (queue.shift() ?? section.name) : section.name));
  return { kind: 'order', sections };
}

/** A name for a section the panel adds, not yet given by rpcd; one taken also as the start of another (new-2-fwd-1) is not free. */
export function nextRef(changes: readonly UciChange[]): string {
  const taken = changes.flatMap((change) => (change.kind === 'add' && change.ref !== undefined ? [change.ref] : []));
  let n = 1;
  while (taken.some((ref) => ref === `new-${n}` || ref.startsWith(`new-${n}-`))) n += 1;
  return `new-${n}`;
}

/** Whether two values say the same; a list and a string of its items separated by spaces do, as fw4 reads lists. */
function sameValue(a: UciValue | undefined, b: UciValue): boolean {
  if (a === undefined) return false;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  const [x, y] = [uciList(a), uciList(b)];
  return x.length === y.length && x.every((item, index) => item === y[index]);
}

/**
 * The sections of `after` that moved against `before`: the fewest that, put
 * elsewhere, give the new order, as one dragged rule moves one rule and not
 * every one it passes. Those keeping their order form the longest run that
 * stays increasing in the old order; the others moved. Sections new in
 * `after` are not counted.
 */
export function movedSections(before: readonly string[], after: readonly string[]): Set<string> {
  const place = new Map(before.map((name, index) => [name, index]));
  const kept = after.filter((name) => place.has(name));
  // Longest increasing subsequence of the old places, with its members.
  const tails: number[] = [];
  const previous: number[] = [];
  kept.forEach((name, index) => {
    const value = place.get(name)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (place.get(kept[tails[middle]!]!)! < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const staying = new Set<string>();
  for (let index = tails.length > 0 ? tails[tails.length - 1]! : -1; index !== -1; index = previous[index]!) staying.add(kept[index]!);
  return new Set(kept.filter((name) => !staying.has(name)));
}
