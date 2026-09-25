const KEY_STORAGE = 'sn-gemini-api-key';
const MODEL = 'gemini-2.5-flash';

export function hasGeminiKey() {
  return Boolean(localStorage.getItem(KEY_STORAGE));
}

export function saveGeminiKey(key) {
  const value = String(key || '').trim();
  if (value) localStorage.setItem(KEY_STORAGE, value);
  else localStorage.removeItem(KEY_STORAGE);
}

// The recording stays on the device until the server returns text.
export async function transcribeAudio(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('Recording is empty');
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) throw new Error('Add your Gemini API key in Settings');
  if (blob.size > 7_000_000) throw new Error('Recording is too large to transcribe');
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read recording'));
    reader.readAsDataURL(blob);
  });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [
      { text: 'Transcribe the speech accurately. Return only the transcription. If there is no clear speech, return an empty string.' },
      { inlineData: { mimeType: blob.type || 'audio/webm', data: base64 } },
    ] }] }),
  });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 400
    ? 'Check the Gemini API key in Settings'
    : 'Transcription failed. Retry the saved recording.');
  const data = await response.json();
  return (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
}
