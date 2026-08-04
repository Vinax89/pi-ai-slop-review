export interface ResourceBudget {
  deadlineMs: number;
  cpuStarted: NodeJS.CpuUsage;
  cpuLimitMs: number;
  memoryLimitBytes?: number;
}

export function createResourceBudget(timeoutMs: number, memoryLimitBytes?: number): ResourceBudget {
  return {
    deadlineMs: Date.now() + timeoutMs,
    cpuStarted: process.cpuUsage(),
    cpuLimitMs: timeoutMs,
    memoryLimitBytes,
  };
}

export function resourceBudgetDiagnostic(budget: ResourceBudget | undefined): string | undefined {
  if (!budget) return undefined;
  if (Date.now() >= budget.deadlineMs) return "scan time budget exhausted";
  const cpu = process.cpuUsage(budget.cpuStarted);
  if ((cpu.user + cpu.system) / 1000 >= budget.cpuLimitMs) return "scan CPU budget exhausted";
  if (budget.memoryLimitBytes !== undefined && process.memoryUsage().heapUsed >= budget.memoryLimitBytes * 0.85) {
    return "scan memory budget exhausted";
  }
  return undefined;
}
