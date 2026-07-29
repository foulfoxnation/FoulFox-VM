import { useState, useEffect, useCallback } from "react";

const MIC_KEY = "foulfox:voice:micDeviceId";
const SPK_KEY = "foulfox:voice:speakerDeviceId";

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface UseAudioDevicesReturn {
  micDevices: AudioDevice[];
  speakerDevices: AudioDevice[];
  selectedMic: string;
  setSelectedMic: (id: string) => void;
  selectedSpeaker: string;
  setSelectedSpeaker: (id: string) => void;
  /** True if the browser has been granted mic permission (labels will be populated). */
  labelsAvailable: boolean;
  /** Call this to request mic permission and re-enumerate devices. */
  requestPermission: () => Promise<void>;
  /** Re-enumerate without requesting permission (e.g. after a device is plugged in). */
  refresh: () => Promise<void>;
  /** True if the browser supports setSinkId (output device selection). */
  outputSelectionSupported: boolean;
}

export function useAudioDevices(): UseAudioDevicesReturn {
  const [micDevices, setMicDevices] = useState<AudioDevice[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<AudioDevice[]>([]);
  const [labelsAvailable, setLabelsAvailable] = useState(false);

  const [selectedMic, setSelectedMicState] = useState<string>(
    () => localStorage.getItem(MIC_KEY) ?? "default"
  );
  const [selectedSpeaker, setSelectedSpeakerState] = useState<string>(
    () => localStorage.getItem(SPK_KEY) ?? "default"
  );

  const outputSelectionSupported =
    typeof HTMLAudioElement !== "undefined" &&
    "setSinkId" in HTMLAudioElement.prototype;

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const raw = await navigator.mediaDevices.enumerateDevices();

      const mics: AudioDevice[] = [];
      const speakers: AudioDevice[] = [];
      let hasLabels = false;

      raw.forEach((d) => {
        const label = d.label || "";
        if (label) hasLabels = true;

        if (d.kind === "audioinput") {
          mics.push({
            deviceId: d.deviceId,
            label: label || (d.deviceId === "default" ? "System default" : `Microphone (${d.deviceId.slice(0, 6)}…)`),
          });
        } else if (d.kind === "audiooutput") {
          speakers.push({
            deviceId: d.deviceId,
            label: label || (d.deviceId === "default" ? "System default" : `Speaker (${d.deviceId.slice(0, 6)}…)`),
          });
        }
      });

      if (mics.length === 0) {
        mics.push({ deviceId: "default", label: "System default" });
      }
      if (speakers.length === 0) {
        speakers.push({ deviceId: "default", label: "System default" });
      }

      setMicDevices(mics);
      setSpeakerDevices(speakers);
      setLabelsAvailable(hasLabels);
    } catch {
      // No media access — leave lists empty, widget falls back to no constraint.
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t) => t.stop());
      await enumerateDevices();
    } catch {
      // Permission denied — enumerate anyway (may return unlabelled entries).
      await enumerateDevices();
    }
  }, [enumerateDevices]);

  useEffect(() => {
    void enumerateDevices();
    // Re-enumerate when devices are plugged/unplugged.
    const handler = () => void enumerateDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
  }, [enumerateDevices]);

  const setSelectedMic = useCallback((id: string) => {
    localStorage.setItem(MIC_KEY, id);
    setSelectedMicState(id);
  }, []);

  const setSelectedSpeaker = useCallback((id: string) => {
    localStorage.setItem(SPK_KEY, id);
    setSelectedSpeakerState(id);
  }, []);

  return {
    micDevices,
    speakerDevices,
    selectedMic,
    setSelectedMic,
    selectedSpeaker,
    setSelectedSpeaker,
    labelsAvailable,
    requestPermission,
    refresh: enumerateDevices,
    outputSelectionSupported,
  };
}
