export type PlanningMode = 'one_go' | 'stepwise';

export function resolvePlanningMode(
  ipInvocationCount: number,
  dataMapperInvocationCount: number,
  remainingGoal: string,
): PlanningMode | null {
  const invocationCount = ipInvocationCount + dataMapperInvocationCount;
  if ((ipInvocationCount > 0 && dataMapperInvocationCount > 0) || invocationCount > 1) return null;
  return invocationCount === 1 && !remainingGoal.trim() ? 'one_go' : 'stepwise';
}
