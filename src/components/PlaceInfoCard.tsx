import React, { useEffect, useState } from 'react';
import { MapPin, Phone } from 'lucide-react';
import { getPlaceInfo, mapsUrl, type PlaceInfo } from '../lib/companyInfo';
export function PlaceInfoCard({ placeId }: { placeId: string }) {
  const [data, setData] = useState<PlaceInfo | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => { let active = true; setData(null); setError(''); void getPlaceInfo(placeId).then(d => { if (active) setData(d); }).catch(() => { if (active) setError('Could not load place details.'); }); return () => { active = false; }; }, [placeId, reload]);
  return <section className="space-y-2 rounded-xl border border-line bg-surface p-4"><h3 className="text-xl font-semibold">Place</h3>{error ? <><p role="alert">{error}</p><button type="button" className="pressable min-h-11 rounded-lg border border-line-control px-3" onClick={() => setReload(n => n + 1)}>Try again</button></> : !data ? <p role="status">Loading place details…</p> : <>{data.address && <><p dir="auto" className="break-words">{data.address}</p><a className="flex min-h-11 items-center gap-2" href={mapsUrl(data.address)} target="_blank" rel="noreferrer"><MapPin className="h-5 w-5" aria-hidden="true" />Open in Maps</a></>}{data.phone && <a className="flex min-h-11 items-center gap-2 break-words" href={`tel:${data.phone}`}><Phone className="h-5 w-5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">Call {data.phone}</span></a>}{!data.address && !data.phone && <p>No address or place phone yet.</p>}</>}</section>;
}
