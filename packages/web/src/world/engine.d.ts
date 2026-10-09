import type { Bot } from "@hamlet/shared/world";

export interface WorldOptions {
  timeOfDay: number;
  dayCycle: boolean;
  skyPalette: string[];
  weather: string;
  world: string;
  botStyle: string;
  wind: number;
  softShadows: boolean;
  ambientOcclusion: boolean;
  rimLight: boolean;
  bloom: boolean;
  colorGrade: boolean;
  edgePan: boolean;
  forceWebGL?: boolean;
}

export interface World {
  setRepos(list: { repo: string; branches: string[] }[]): void;
  setBots(bots: Bot[]): void;
  setOptions(o: Partial<WorldOptions>): void;
  select(id: string | null, fly?: boolean): void;
  flyToCity(repo: string, fh?: number): void;
  zoom(dir: number): void;
  frameAll(): void;
  compile(): Promise<void>;
  reveal(): void;
}

export function createWorld(init: {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  bubble: HTMLElement;
  options: Partial<WorldOptions>;
  callbacks: { onSelect?(id: string | null): void; permissionOpen?(): boolean };
}): Promise<World>;
