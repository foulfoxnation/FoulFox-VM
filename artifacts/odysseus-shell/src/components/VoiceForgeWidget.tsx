import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, MicOff, Volume2, Loader2, X, MessageSquare, Radio } from "lucide-react";
import { authedFetch } from "@/lib/shell-token";
import { cn } from "@/lib/utils";

type VoiceState = "idle" | "recording" | "processing" | "speaking" | "error";

interface VoiceForgeWidgetProps {
  onAgentResponse?: () => void;
}

function getSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export function VoiceForgeWidget({ onAgentResponse }: VoiceForgeWidgetProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [userText, setUserText] = useState("");
  const [agentText, setAgentText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const clearAutoClose = () => {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
  };

  const scheduleAutoClose = useCallback(() => {
    clearAutoClose();
    autoCloseRef.current = setTimeout(() => {
      setPanelOpen(false);
      setVoiceState("idle");
    }, 7000);
  }, []);

  const stopAllAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const handleClose = useCallback(() => {
    stopAllAudio();
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    clearAutoClose();
    setPanelOpen(false);
    setVoiceState("idle");
    setUserText("");
    setAgentText("");
    setErrorMsg("");
  }, [stopAllAudio]);

  useEffect(() => {
    return () => {
      clearAutoClose();
      stopAllAudio();
    };
  }, [stopAllAudio]);

  useEffect(() => {
    if (!panelOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [panelOpen, handleClose]);

  const fallbackTTS = useCallback((text: string) => {
    if ("speechSynthesis" in window) {
      const utt = new SpeechSynthesisUtterance(text);
      utt.onend = scheduleAutoClose;
      utt.onerror = scheduleAutoClose;
      window.speechSynthesis.speak(utt);
    } else {
      scheduleAutoClose();
    }
  }, [scheduleAutoClose]);

  const playTTS = useCallback(async (text: string) => {
    setVoiceState("speaking");
    try {
      const res = await authedFetch("/api/odysseus/api/tts/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, format: "audio" }),
      });
      if (!res.ok) throw new Error("TTS unavailable");
      const blob = await res.blob();
      if (!blob.size) throw new Error("Empty audio");
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        scheduleAutoClose();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        fallbackTTS(text);
      };
      await audio.play();
    } catch {
      fallbackTTS(text);
    }
  }, [fallbackTTS, scheduleAutoClose]);

  const sendToAgent = useCallback(async (text: string) => {
    if (!text.trim()) {
      setVoiceState("error");
      setErrorMsg("Didn't catch that — please try again.");
      scheduleAutoClose();
      return;
    }
    setUserText(text.trim());
    setAgentText("");
    setErrorMsg("");
    setVoiceState("processing");
    try {
      const res = await authedFetch("/api/odysseus/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim() }),
      });
      if (!res.ok) throw new Error("Agent unavailable");
      const data = await res.json() as { response?: string };
      const reply = (data.response ?? "").trim();
      setAgentText(reply);
      onAgentResponse?.();
      if (reply) {
        await playTTS(reply);
      } else {
        scheduleAutoClose();
      }
    } catch {
      setVoiceState("error");
      setErrorMsg("Agent didn't respond. Make sure the AI service is running.");
      scheduleAutoClose();
    }
  }, [playTTS, onAgentResponse, scheduleAutoClose]);

  const startBrowserSTT = useCallback(() => {
    const SR =
      (window as { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ??
      (window as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) {
      setVoiceState("error");
      setErrorMsg("Microphone not available. Check browser permissions.");
      scheduleAutoClose();
      return;
    }
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      void sendToAgent(text);
    };
    recognition.onerror = () => {
      setVoiceState("error");
      setErrorMsg("Mic access denied or no speech detected.");
      scheduleAutoClose();
    };
    try { recognition.start(); } catch { /* already running */ }
    setVoiceState("recording");
  }, [sendToAgent, scheduleAutoClose]);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    setVoiceState("processing");
    try {
      const form = new FormData();
      form.append("file", blob, "voice.webm");
      const res = await authedFetch("/api/odysseus/api/stt/transcribe", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("STT unavailable");
      const data = await res.json() as { text?: string };
      const text = (data.text ?? "").trim();
      if (!text) throw new Error("Empty");
      await sendToAgent(text);
    } catch {
      setVoiceState("error");
      setErrorMsg("Voice Forge STT is starting up — retrying with browser STT.");
      startBrowserSTT();
    }
  }, [sendToAgent, startBrowserSTT]);

  const startRecording = useCallback(async () => {
    clearAutoClose();
    stopAllAudio();
    setUserText("");
    setAgentText("");
    setErrorMsg("");
    setPanelOpen(true);

    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      startBrowserSTT();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = getSupportedMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: mr.mimeType || "audio/webm",
        });
        void transcribeBlob(blob);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setVoiceState("recording");
    } catch {
      startBrowserSTT();
    }
  }, [transcribeBlob, startBrowserSTT, stopAllAudio]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  const handleMicClick = useCallback(() => {
    if (voiceState === "idle" || voiceState === "error") {
      void startRecording();
    } else if (voiceState === "recording") {
      stopRecording();
    } else if (voiceState === "speaking") {
      stopAllAudio();
      void startRecording();
    }
  }, [voiceState, startRecording, stopRecording, stopAllAudio]);

  const MicIconEl = voiceState === "recording"
    ? MicOff
    : voiceState === "speaking"
    ? Volume2
    : Mic;

  const stateLabel =
    voiceState === "recording" ? "Listening…"
    : voiceState === "processing" ? "Thinking…"
    : voiceState === "speaking" ? "Speaking"
    : voiceState === "error" ? "Error"
    : null;

  return (
    <div className="relative">
      <button
        className={cn(
          "relative flex h-8 items-center gap-1.5 rounded px-2 text-xs transition-all",
          voiceState === "idle" || voiceState === "error"
            ? "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            : voiceState === "recording"
            ? "bg-red-500/15 text-red-400 hover:bg-red-500/20"
            : voiceState === "processing"
            ? "text-muted-foreground cursor-wait opacity-70"
            : "bg-primary/10 text-primary hover:bg-primary/20",
        )}
        onClick={handleMicClick}
        disabled={voiceState === "processing"}
        title={
          voiceState === "idle" ? "Voice Forge — tap to speak to the Agent from anywhere"
          : voiceState === "recording" ? "Listening — tap to send"
          : voiceState === "processing" ? "Agent is thinking…"
          : voiceState === "speaking" ? "Agent speaking — tap mic to interrupt and speak"
          : "Voice Forge — tap to try again"
        }
        data-testid="voice-forge-mic-btn"
      >
        {voiceState === "processing" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <MicIconEl className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">Voice Forge</span>

        {voiceState === "recording" && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 animate-ping" />
        )}
        {voiceState === "speaking" && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
        )}
      </button>

      {panelOpen && (
        <div
          ref={panelRef}
          className="absolute right-0 top-10 z-50 w-80 rounded-lg border bg-card shadow-2xl"
          data-testid="voice-forge-panel"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Radio className="h-3.5 w-3.5 text-primary" />
              Voice Forge
              {stateLabel && (
                <span
                  className={cn(
                    "ml-1 text-xs font-normal",
                    voiceState === "recording" ? "text-red-400" :
                    voiceState === "speaking" ? "text-primary" :
                    voiceState === "error" ? "text-destructive" :
                    "text-muted-foreground",
                  )}
                >
                  {voiceState === "recording" && "● "}
                  {stateLabel}
                </span>
              )}
            </div>
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={handleClose}
              data-testid="voice-forge-close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-2 p-3">
            {!userText && !errorMsg && (
              <p className="py-3 text-center text-xs text-muted-foreground">
                {voiceState === "recording"
                  ? "Listening… tap the mic button to send."
                  : "Tap the mic to start speaking to the Agent."}
              </p>
            )}

            {userText && (
              <div className="rounded-md bg-muted/60 p-2.5">
                <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  You
                </p>
                <p className="text-sm leading-snug">{userText}</p>
              </div>
            )}

            {voiceState === "processing" && (
              <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Agent is thinking…
              </div>
            )}

            {agentText && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
                <div className="mb-0.5 flex items-center gap-1">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</p>
                  {voiceState === "speaking" && (
                    <Volume2 className="h-3 w-3 text-primary animate-pulse" />
                  )}
                </div>
                <p className="line-clamp-8 text-sm leading-snug">{agentText}</p>
              </div>
            )}

            {errorMsg && (
              <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                {errorMsg}
              </p>
            )}
          </div>

          <div className="border-t px-3 pb-3 pt-2">
            <button
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-md py-2 text-xs font-medium transition-colors",
                voiceState === "recording"
                  ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                  : voiceState === "processing"
                  ? "cursor-wait bg-muted text-muted-foreground opacity-60"
                  : voiceState === "speaking"
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20",
              )}
              onClick={handleMicClick}
              disabled={voiceState === "processing"}
            >
              {voiceState === "recording" ? (
                <><MicOff className="h-3.5 w-3.5" /> Stop &amp; Send</>
              ) : voiceState === "processing" ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…</>
              ) : voiceState === "speaking" ? (
                <><Mic className="h-3.5 w-3.5" /> Interrupt &amp; Speak</>
              ) : (
                <><Mic className="h-3.5 w-3.5" /> {userText ? "Speak Again" : "Start Speaking"}</>
              )}
            </button>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              Voice is unified across all OS workspaces. Memory is always shared.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
