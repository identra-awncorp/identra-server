export type ModuleStatus = 'scaffolded' | 'ready';

export interface ServiceStatus {
  module: string;
  status: ModuleStatus;
  purpose: string;
  next: string[];
}

export function createServiceStatus(input: ServiceStatus): ServiceStatus {
  return input;
}
