import React, { useState, useRef } from 'react';
import { AlertTriangle, Camera, Mic, X, Send } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface IncidentReporterProps {
  venueId: string;
  venueName: string;
  currentUserEmail: string;
  currentUserName: string;
  onClose: () => void;
  onReported: () => void;
}

export function IncidentReporter({ venueId, venueName, currentUserEmail, currentUserName, onClose, onReported }: IncidentReporterProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [photoData, setPhotoData] = useState<string>('');
  const [recording, setRecording] = useState(false);
  const [voiceNoteData, setVoiceNoteData] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 800 / Math.max(img.width, img.height));
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        setPhotoData(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => setVoiceNoteData(reader.result as string);
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      console.error('Mic access denied:', e);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          title: title.trim(),
          description: description.trim(),
          severity,
          photoData: photoData || undefined,
          voiceNoteData: voiceNoteData || undefined,
          reporterEmail: currentUserEmail,
          reporterName: currentUserName,
        }),
      });
      if (res.ok) {
        onReported();
        onClose();
      }
    } catch (e) {
      console.error('Failed to report incident:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const severityColors = {
    low: 'border-line',
    medium: 'border-gold/50 bg-gold/5',
    high: 'border-orange-500/50 bg-orange-500/5',
    critical: 'border-rose-500 bg-rose-500/10',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-zinc-900 border-b border-line p-4 flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2 text-rose-600">
            <AlertTriangle className="w-5 h-5" />
            Report Incident
          </h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-sunken transition cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs text-ink-faint">{venueName}</div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What happened? (e.g. Walk-in at 45°F)"
            className="w-full px-3 py-2.5 text-sm rounded-xl border border-line bg-sunken"
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Details... (what, where, when)"
            className="w-full px-3 py-2.5 text-sm rounded-xl border border-line bg-sunken min-h-[80px]"
          />

          <div>
            <label className="text-xs font-bold mb-1.5 block">Severity</label>
            <div className="grid grid-cols-4 gap-2">
              {(['low', 'medium', 'high', 'critical'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className={`py-2 px-1 text-xs font-bold rounded-xl border-2 transition cursor-pointer capitalize ${
                    severity === s ? severityColors[s] + ' ring-2 ring-offset-1' : 'border-line opacity-60'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <label className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-line bg-sunken cursor-pointer hover:bg-line/20 transition">
              <Camera className="w-4 h-4" />
              <span className="text-xs font-bold">{photoData ? 'Photo added ✓' : 'Add photo'}</span>
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
            </label>
            <button
              onClick={recording ? stopRecording : startRecording}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border transition cursor-pointer font-bold text-xs ${
                recording
                  ? 'border-rose-500 bg-rose-500/10 text-rose-600 animate-pulse'
                  : 'border-line bg-sunken hover:bg-line/20'
              }`}
            >
              <Mic className="w-4 h-4" />
              {recording ? 'Stop' : voiceNoteData ? 'Re-record voice' : 'Voice note'}
            </button>
          </div>

          {photoData && (
            <img src={photoData} alt="Incident" className="w-full rounded-xl border border-line max-h-48 object-cover" />
          )}
          {voiceNoteData && !recording && (
            <audio src={voiceNoteData} controls className="w-full" />
          )}

          <button
            onClick={submit}
            disabled={!title.trim() || submitting}
            className="w-full py-3 rounded-xl bg-rose-600 text-white text-sm font-bold disabled:opacity-50 transition cursor-pointer flex items-center justify-center gap-2"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Sending...' : 'Send Alert'}
          </button>
          <p className="text-[11px] text-ink-faint text-center">
            Instantly notifies admins + creates a follow-up task
          </p>
        </div>
      </div>
    </div>
  );
}
