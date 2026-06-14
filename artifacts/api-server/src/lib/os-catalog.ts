import { type OsKind } from "./vm-capabilities";

// ── OS image catalog ─────────────────────────────────────────────────────────
// Single source of truth for the operating systems the in-app picker offers and
// the appliance auto-downloads. The UI fetches this (minus the resolution
// detail) from GET /vm/os-images, so the menu and the backend can never drift.
//
// SECURITY: image ids are an allowlist. The UI only ever sends an `id`; the raw
// download URLs / Microsoft product ids live here on the server and are never
// accepted from the client.

export type ResolverKind =
  | "cloud-image" // ready-to-boot qcow2 cloud image, used directly as the disk
  | "windows-msdl" // official Windows ISO resolved from Microsoft on demand
  | "gated"; // not auto-provisioned (e.g. macOS — Apple hardware only)

export interface OsImageSpec {
  id: string; // allowlisted id, e.g. "ubuntu-24.04", "windows-11"
  family: OsKind; // linux | windows | macos
  label: string; // "Ubuntu 24.04 LTS"
  version: string; // "24.04 LTS (Noble)"
  stability: string; // user-facing "most stable release" labeling
  blurb: string; // short description shown under the picker
  autoDownload: boolean; // true = appliance fetches it with no user-supplied media
  defaultRamGb: number;
  defaultDiskGb: number;
  resolver: ResolverKind;

  // ── cloud-image resolution (server-only) ──────────────────────────────────
  imageUrl?: string; // stable "latest" URL that always points at the newest point release
  imageFilename?: string; // cache filename
  sha256Url?: string; // optional checksum manifest (SHA256SUMS) for integrity

  // ── windows-msdl resolution (server-only) ─────────────────────────────────
  productEditionId?: string; // Microsoft ProductEditionId for the consumer download flow
  isoFilename?: string; // cache filename for the downloaded ISO
}

// "Most stable release" per OS. Linux entries use vendor URLs that always
// resolve to the current stable point release, so they stay current without
// code edits. Windows is resolved live from Microsoft at download time.
export const OS_IMAGES: OsImageSpec[] = [
  {
    id: "ubuntu-24.04",
    family: "linux",
    label: "Ubuntu 24.04 LTS",
    version: "24.04 LTS (Noble)",
    stability: "Stable · Long-Term Support",
    blurb:
      "Latest Ubuntu LTS cloud image — downloaded automatically, SSH enabled on first boot. No installer steps.",
    autoDownload: true,
    defaultRamGb: 4,
    defaultDiskGb: 32,
    resolver: "cloud-image",
    // The "release" path always serves the newest 24.04.x point release.
    imageUrl:
      "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img",
    imageFilename: "ubuntu-24.04-server-cloudimg-amd64.img",
  },
  {
    id: "debian-12",
    family: "linux",
    label: "Debian 12",
    version: "12 (Bookworm)",
    stability: "Stable",
    blurb:
      "Debian stable cloud image — downloaded automatically, SSH enabled on first boot. No installer steps.",
    autoDownload: true,
    defaultRamGb: 4,
    defaultDiskGb: 32,
    resolver: "cloud-image",
    // The "latest" symlink always serves the current Debian 12 point release.
    imageUrl:
      "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
    imageFilename: "debian-12-genericcloud-amd64.qcow2",
  },
  {
    id: "windows-11",
    family: "windows",
    label: "Windows 11",
    version: "11 (latest)",
    stability: "Stable · Latest release",
    blurb:
      "Latest Windows 11 — the official ISO is downloaded automatically along with virtio drivers. Bring your own license key to activate.",
    autoDownload: true,
    defaultRamGb: 4,
    defaultDiskGb: 64,
    resolver: "windows-msdl",
    productEditionId: "2935",
    isoFilename: "windows-11.iso",
  },
  {
    id: "windows-10",
    family: "windows",
    label: "Windows 10",
    version: "10 (22H2)",
    stability: "Stable · Final release (22H2)",
    blurb:
      "Windows 10 22H2 — the official ISO is downloaded automatically along with virtio drivers. Bring your own license key to activate.",
    autoDownload: true,
    defaultRamGb: 4,
    defaultDiskGb: 64,
    resolver: "windows-msdl",
    productEditionId: "2618",
    isoFilename: "windows-10.iso",
  },
  {
    id: "macos",
    family: "macos",
    label: "macOS",
    version: "—",
    stability: "Apple hardware only",
    blurb:
      "macOS runs only on genuine Apple hardware (Apple's software licence + Hypervisor.framework).",
    autoDownload: false,
    defaultRamGb: 8,
    defaultDiskGb: 64,
    resolver: "gated",
  },
];

export function getOsImage(id: string | null | undefined): OsImageSpec | undefined {
  if (!id) return undefined;
  return OS_IMAGES.find((i) => i.id === id);
}

export function isOsImageId(v: unknown): v is string {
  return typeof v === "string" && OS_IMAGES.some((i) => i.id === v);
}

// Pick a sensible default image for a bare osKind (back-compat for callers that
// only pass osKind and not a specific image id).
export function defaultImageForOs(os: OsKind): OsImageSpec | undefined {
  return OS_IMAGES.find((i) => i.family === os);
}

// ── UI-safe projection ────────────────────────────────────────────────────────
// Everything the picker needs, with NO raw URLs or Microsoft product ids.
export interface OsImagePublic {
  id: string;
  family: OsKind;
  label: string;
  version: string;
  stability: string;
  blurb: string;
  autoDownload: boolean;
  defaultRamGb: number;
  defaultDiskGb: number;
}

export function toPublic(i: OsImageSpec): OsImagePublic {
  return {
    id: i.id,
    family: i.family,
    label: i.label,
    version: i.version,
    stability: i.stability,
    blurb: i.blurb,
    autoDownload: i.autoDownload,
    defaultRamGb: i.defaultRamGb,
    defaultDiskGb: i.defaultDiskGb,
  };
}
