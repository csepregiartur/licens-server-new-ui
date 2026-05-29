export interface HardwareInfo {
  machine_id?: string;
  hostname?: string;
  os?: string;
  os_version?: string;
  architecture?: string;
  processor?: string;
  cpu_cores?: number;
  mac_addresses?: string;
}

export interface LicenseActivation {
  activatedAt: string;
  machineId: string;
  hardwareInfo: HardwareInfo;
  ip: string;
}

export interface License {
  licenseKey: string;
  type: "perpetual" | "subscription" | "trial" | "floating" | "node_locked";
  features: {
    premium_feature: boolean;
    [key: string]: boolean;
  };
  active: boolean;
  maxOfflineDays: number;
  exp: string | null;  // ISO string
  notes: string;
  machineId: string | null;
  activations: LicenseActivation[];
}

export interface RequestLog {
  id: string;
  timestamp: string;
  type: "activation" | "validation" | "check";
  licenseKey: string;
  machineId: string;
  success: boolean;
  details: string;
  os?: string;
  clientVersion?: string;
}

export interface SystemSettings {
  publicKey: string;
  totalLicenses: number;
  totalLogs: number;
  databasePath: string;
}
