export interface ConsoleNavigationItem {
  id: string;
  path: string;
  href: string;
  primaryLabel: string;
  secondaryLabel: string | null;
  icon: string;
  attention: number;
  indicatorTone?: 'attention' | 'waiting';
  active: boolean;
}

export interface ConsoleNavigationGroup {
  id: string;
  label: string;
  attention: number;
  items: ConsoleNavigationItem[];
}

export function resolveActiveNavigationGroup(
  groups: readonly ConsoleNavigationGroup[],
): string | null {
  return groups.find(group => group.items.some(item => item.active))?.id ?? null;
}

export function filterConsoleNavigation(
  groups: readonly ConsoleNavigationGroup[],
  query: string,
): ConsoleNavigationGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return groups.map(group => ({ ...group, items: [...group.items] }));
  }

  return groups.flatMap((group) => {
    const groupMatches = group.label.toLocaleLowerCase().includes(normalizedQuery);
    const items = groupMatches
      ? [...group.items]
      : group.items.filter(item => (
          item.primaryLabel.toLocaleLowerCase().includes(normalizedQuery)
          || item.secondaryLabel?.toLocaleLowerCase().includes(normalizedQuery)
          || item.id.toLocaleLowerCase().includes(normalizedQuery)
        ));
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}
