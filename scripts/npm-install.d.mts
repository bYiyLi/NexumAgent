export interface NpmAgentInstallOptions {
  profile: "development" | "production";
  version: string;
  config?: { server_url?: string; token?: string };
  home?: string;
  register?: boolean;
  start?: boolean;
  source?: string;
  fromUpdate?: boolean;
}
export declare function installNpmAgent(options: NpmAgentInstallOptions): Promise<{
  profile: string; version: string; serviceRegistered: boolean; startRequested: boolean;
}>;
export declare function updateNpmAgent(options: {profile:"development"|"production"; version:string; home?:string}): Promise<unknown>;
