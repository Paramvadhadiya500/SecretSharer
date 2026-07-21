"use client";

import { useState, useEffect } from "react";
import { SessionProvider, useSession, signIn, signOut } from "next-auth/react";

const saveUrl = process.env.NEXT_PUBLIC_API_SAVE_URL;
const readUrl = process.env.NEXT_PUBLIC_API_READ_URL;
const dashboardUrl = process.env.NEXT_PUBLIC_API_DASHBOARD_URL;

// --- CRYPTOGRAPHY HELPERS ---
function bufferToBase64(buf) {
  const binstr = Array.prototype.map.call(buf, ch => String.fromCharCode(ch)).join('');
  return btoa(binstr);
}
function base64ToBuffer(base64) {
  const binstr = atob(base64);
  const buf = new Uint8Array(binstr.length);
  Array.prototype.forEach.call(binstr, (ch, i) => { buf[i] = ch.charCodeAt(0); });
  return buf;
}
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits", "deriveKey"]);
  return await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
}

// Wrap the main app in the SessionProvider for Authentication
export default function Home() {
  return (
    <SessionProvider>
      <DeadDropApp />
    </SessionProvider>
  );
}

function DeadDropApp() {
  const { data: session } = useSession(); // Gets the logged-in GitHub user

  const [view, setView] = useState("create"); 
  const [dbId, setDbId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [isError, setIsError] = useState(false);

  // Form States
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState("");
  const [expireSeconds, setExpireSeconds] = useState("86400");
  const [maxViews, setMaxViews] = useState("1"); // 👈 NEW: Track how many views are allowed
  const [wantsAlert, setWantsAlert] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [decryptedText, setDecryptedText] = useState("");
  const [downloadInfo, setDownloadInfo] = useState(null);
  
  // Dashboard State
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) {
      setDbId(id);
      setView("read");
    }
  }, []);

  const handleStatus = (msg, error = false) => {
    setStatusMsg(msg);
    setIsError(error);
  };

  const fetchDashboard = async () => {
    if (!session) return;
    setIsLoading(true);
    handleStatus("Fetching your secure logs...");
    try {
      const res = await fetch(dashboardUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: session.user.email })
      });
      if (!res.ok) throw new Error("Could not fetch dashboard.");
      const data = await res.json();
      setLogs(data.logs || []);
      setView("dashboard");
      setStatusMsg("");
    } catch (e) {
      handleStatus(e.message, true);
    }
    setIsLoading(false);
  };

  const handleCreate = async () => {
    if (!text && !file) return handleStatus("Please enter text or select a file.", true);
    if (!password) return handleStatus("Password is required!", true);
    if (file && file.size > 10 * 1024 * 1024) return handleStatus("File max 10MB.", true);

    setIsLoading(true);
    handleStatus("Deriving Encryption Key...");

    try {
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt);
      const enc = new TextEncoder();

      const metadata = JSON.stringify({ text, fileName: file ? file.name : null, fileType: file ? file.type : null });
      const encryptedMeta = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(metadata));
      
      const combinedMeta = new Uint8Array(salt.length + iv.length + encryptedMeta.byteLength);
      combinedMeta.set(salt, 0); combinedMeta.set(iv, salt.length); combinedMeta.set(new Uint8Array(encryptedMeta), salt.length + iv.length);
      const finalMetaBlob = bufferToBase64(combinedMeta);

      handleStatus("Uploading encrypted payload to AWS...");
      
      const userEmail = session ? session.user.email : "anonymous";
      
      // 🎯 We define the ID right here before the fetch
      const generatedId = "web-" + window.crypto.getRandomValues(new Uint32Array(1))[0].toString(16);

      // 🎯 Here is your exact fetch block!
      const response = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: generatedId,
          secretId: generatedId,
          secretData: finalMetaBlob,
          hasFile: !!file,
          wantsAlert: wantsAlert,
          expireSeconds: parseInt(expireSeconds),
          userEmail: userEmail,
          maxViews: parseInt(maxViews)
        })
      });

      if (response.status === 429) throw new Error("Rate limit exceeded.");
      if (!response.ok) throw new Error("AWS Server Error");
      const result = await response.json();

      if (file && result.uploadUrl) {
        handleStatus("Encrypting & Uploading file to S3 Vault...");
        const fileBuffer = await file.arrayBuffer();
        const encryptedFileBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, fileBuffer);
        
        const s3Response = await fetch(result.uploadUrl, {
          method: 'PUT',
          body: encryptedFileBuffer,
          headers: { "Content-Type": "application/octet-stream" }
        });
        if (!s3Response.ok) throw new Error("Failed to upload file to S3.");
      }

      const baseUrl = window.location.href.split('?')[0].split('#')[0];
      setShareLink(`${baseUrl}?id=${result.id || result.secretId || generatedId}`);
      setView("share");
      setIsLoading(false);

    } catch (error) {
      handleStatus(error.message, true);
      setIsLoading(false);
    }
  };

  const handleRead = async () => {
    if (!password) return handleStatus("Password is required!", true);
    setIsLoading(true);
    handleStatus("Fetching Metadata & S3 Pass from AWS...");

    try {
      // 🎯 THE FIX: Force it to grab the ID straight from the browser's URL bar!
      const actualId = new URLSearchParams(window.location.search).get("id") || dbId;

      if (!actualId) {
          setIsLoading(false);
          return handleStatus("No ID found! Please make sure you are using the full link.", true);
      }
      
      console.log("🚨 SENDING THIS ID TO AWS:", actualId);

      const response = await fetch(readUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: actualId })
      });

      if (response.status === 404) throw new Error("Secret not found or expired.");
      if (!response.ok) throw new Error("AWS Server Error");
      const result = await response.json();

      handleStatus("Decrypting Metadata...");
      const combined = base64ToBuffer(result.secretData);
      const salt = combined.slice(0, 16);
      const iv = combined.slice(16, 28);
      const encryptedMeta = combined.slice(28);

      const key = await deriveKey(password, salt);
      const decryptedMetaBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encryptedMeta);
      
      const dec = new TextDecoder();
      const metadata = JSON.parse(dec.decode(decryptedMetaBuffer));

      setDecryptedText(metadata.text || "No text message provided.");

      if (result.downloadUrl && metadata.fileName) {
        handleStatus("Downloading encrypted file from S3...");
        const fileRes = await fetch(result.downloadUrl);
        if (!fileRes.ok) throw new Error("Could not download file from S3.");
        const encryptedFileBuffer = await fileRes.arrayBuffer();

        handleStatus("Decrypting file locally...");
        const decryptedFileBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encryptedFileBuffer);
        
        const blob = new Blob([decryptedFileBuffer], { type: metadata.fileType || "application/octet-stream" });
        setDownloadInfo({ url: URL.createObjectURL(blob), name: metadata.fileName });
      }

      setView("decrypted");
      handleStatus(result.message, false); 
      setIsLoading(false);

    } catch (error) {
      handleStatus("Wrong Password, Rate Limited, or Destroyed.", true);
      setIsLoading(false);
    }
  };

return (
    <main className="min-h-screen bg-black text-cyan-500 font-mono flex items-center justify-center p-4 selection:bg-cyan-900 selection:text-cyan-100 overflow-hidden relative">
      
      {/* 🌐 Background Grid & Scanline Effects */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,black_100%)] pointer-events-none"></div>

      {/* 🛡️ Main Vault Container */}
      <div className="relative w-full max-w-3xl bg-black/40 backdrop-blur-md border border-cyan-900/50 p-8 shadow-[0_0_50px_rgba(6,182,212,0.05)] z-10">
        
        {/* Decorative Corner Brackets */}
        <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-cyan-600/50"></div>
        <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-cyan-600/50"></div>
        <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-cyan-600/50"></div>
        <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-cyan-600/50"></div>

        {/* System Diagnostics Header */}
        <div className="flex justify-between items-start mb-10 border-b border-cyan-900/30 pb-4">
          <div>
            <h1 className="text-3xl font-bold text-cyan-400 tracking-[0.2em] uppercase mb-1 drop-shadow-[0_0_8px_rgba(6,182,212,0.5)]">
              Protocol: DeadDrop
            </h1>
            <p className="text-cyan-700 text-xs tracking-widest uppercase animate-pulse">Status: Secured & Encrypted // System Online</p>
          </div>
          
          <div className="text-right text-[10px] text-cyan-800 tracking-widest uppercase space-y-1">
            <p>Lat: 23.0225° N, 72.5714° E</p>
            <p>Uplink: AP-SOUTH-1</p>
            {session ? (
              <div className="mt-2 space-x-3">
                <button onClick={() => { setView("create"); setStatusMsg(""); }} className="text-cyan-500 hover:text-cyan-300 border border-cyan-900 px-2 py-1 bg-cyan-950/20 uppercase tracking-widest">New</button>
                <button onClick={fetchDashboard} className="text-cyan-500 hover:text-cyan-300 border border-cyan-900 px-2 py-1 bg-cyan-950/20 uppercase tracking-widest">Logs</button>
                <button onClick={() => signOut()} className="text-rose-500 hover:text-rose-400 border border-rose-900/50 px-2 py-1 bg-rose-950/20 uppercase tracking-widest">Exit</button>
              </div>
            ) : (
               <button onClick={() => signIn("github")} className="mt-2 text-cyan-500 hover:text-cyan-300 border border-cyan-900 px-2 py-1 bg-cyan-950/20 transition-colors uppercase tracking-widest">Authenticate [GitHub]</button>
            )}
          </div>
        </div>

        {/* --- VIEW: CREATE --- */}
        {view === "create" && (
          <div className="space-y-8 animate-in fade-in duration-700">
            <div className="relative group">
              <label className="absolute -top-3 left-4 bg-black px-2 text-[10px] text-cyan-600 uppercase tracking-widest font-bold z-10">Classified Intel</label>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="INPUT DATA STREAM..." className="w-full h-32 bg-cyan-950/10 border border-cyan-900/50 p-4 text-sm focus:outline-none focus:border-cyan-400 text-cyan-100 transition-all resize-none relative z-0" />
              <div className="mt-2 flex items-center bg-cyan-950/10 border border-cyan-900/50 p-2">
                 <span className="text-xs text-cyan-700 px-3 uppercase tracking-wider">Attach Payload:</span>
                 <input type="file" onChange={(e) => setFile(e.target.files[0])} className="w-full bg-transparent text-sm text-cyan-500 focus:outline-none file:mr-4 file:py-1 file:px-3 file:border file:border-cyan-800 file:text-xs file:font-bold file:bg-cyan-950/30 file:text-cyan-400 hover:file:bg-cyan-900/50 cursor-pointer transition-colors" />
              </div>
            </div>
            
            <div className="border border-cyan-900/30 p-5 bg-cyan-[0.01]">
              <label className="block text-xs text-cyan-600 uppercase tracking-widest font-bold mb-4">Encryption Parameters</label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="block text-[9px] text-cyan-700 mb-1 uppercase tracking-widest">Master Key</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-transparent border-b border-cyan-900 py-2 text-sm focus:outline-none focus:border-cyan-400 text-cyan-300 placeholder-cyan-900" placeholder="••••••••" />
                </div>
                <div>
                  <label className="block text-[9px] text-cyan-700 mb-1 uppercase tracking-widest">Auto-Destruct (Secs)</label>
                  <input type="number" value={expireSeconds} onChange={(e) => setExpireSeconds(e.target.value)} className="w-full bg-transparent border-b border-cyan-900 py-2 text-sm focus:outline-none focus:border-cyan-400 text-cyan-300 font-mono" placeholder="86400" />
                </div>
                <div>
                  <label className="block text-[9px] text-cyan-700 mb-1 uppercase tracking-widest">View Threshold</label>
                  <input type="number" value={maxViews} onChange={(e) => setMaxViews(e.target.value)} className="w-full bg-transparent border-b border-cyan-900 py-2 text-sm focus:outline-none focus:border-cyan-400 text-cyan-300 font-mono" placeholder="1" />
                </div>
              </div>
              <div className="flex items-center mt-6">
                <input type="checkbox" id="audit" checked={wantsAlert} onChange={(e) => setWantsAlert(e.target.checked)} className="w-4 h-4 text-cyan-600 bg-transparent border-cyan-700 rounded focus:ring-0 cursor-pointer accent-cyan-500" />
                <label htmlFor="audit" className="ml-3 text-[10px] text-cyan-600 uppercase tracking-widest cursor-pointer hover:text-cyan-400">Transmit SNS Burn Receipt</label>
              </div>
            </div>

            <button onClick={handleCreate} disabled={isLoading} className="w-full bg-cyan-950/40 border border-cyan-500/50 hover:bg-cyan-900/60 hover:border-cyan-300 disabled:opacity-50 text-cyan-400 tracking-[0.3em] uppercase text-sm py-4 transition-all shadow-[inset_0_0_20px_rgba(6,182,212,0.1)] hover:shadow-[0_0_20px_rgba(6,182,212,0.3)]">
              {isLoading ? "INITIATING SECURE UPLINK..." : "INITIALIZE DEAD DROP"}
            </button>
            {statusMsg && <div className={`text-xs mt-2 text-center tracking-widest uppercase ${isError ? 'text-rose-500 animate-pulse' : 'text-cyan-400'}`}> {statusMsg}</div>}
          </div>
        )}

        {/* --- VIEW: SHARE --- */}
        {view === "share" && (
          <div className="text-center space-y-8 animate-in zoom-in-95 duration-500 py-10">
            <h2 className="text-2xl text-cyan-400 tracking-[0.3em] uppercase drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]">Uplink Established</h2>
            <div className="bg-black/80 p-4 border border-cyan-500/50 break-all text-cyan-300 text-sm font-mono shadow-[0_0_30px_rgba(6,182,212,0.15)]">{shareLink}</div>
            <p className="text-[10px] text-cyan-700 uppercase tracking-widest">Transmit the decryption key via a secondary out-of-band channel.</p>
            <div className="space-x-6">
             <button 
                onClick={() => { 
                  navigator.clipboard.writeText(shareLink); 
                  setStatusMsg("UPLINK COPIED TO SECURE CLIPBOARD."); 
                }} 
                className="bg-cyan-950/40 border border-cyan-500/50 hover:bg-cyan-900/60 text-cyan-400 tracking-[0.2em] uppercase text-xs py-3 px-6 transition-all"
              >
                Copy Link
              </button>
              <button onClick={() => { setView("create"); setStatusMsg(""); }} className="bg-transparent border border-cyan-900 hover:border-cyan-500 text-cyan-600 hover:text-cyan-400 tracking-[0.2em] uppercase text-xs py-3 px-6 transition-all">Return</button>
            </div>
          </div>
        )}

        {/* --- VIEW: DASHBOARD --- */}
        {view === "dashboard" && (
          <div className="animate-in fade-in duration-500">
            <h2 className="text-lg text-cyan-500 mb-6 tracking-widest uppercase border-b border-cyan-900/50 pb-2">Transmission Logs</h2>
            {isLoading ? <p className="text-cyan-800 text-center animate-pulse text-xs uppercase tracking-widest">Retrieving Secure Records...</p> : logs.length === 0 ? (
              <p className="text-cyan-800 text-center py-8 text-xs uppercase tracking-widest">No active uplinks found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-cyan-600 font-mono">
                  <thead>
                    <tr className="border-b border-cyan-900/50 text-cyan-400 uppercase tracking-widest">
                      <th className="pb-3 font-normal">Payload ID</th>
                      <th className="pb-3 font-normal">Status</th>
                      <th className="pb-3 font-normal">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => (
                      <tr key={log.secretId} className="border-b border-cyan-950 hover:bg-cyan-950/20 transition-colors">
                        <td className="py-4 truncate max-w-[120px] text-cyan-500" title={log.secretId}>{log.secretId}</td>
                        <td className="py-4">
                          <span className={`px-2 py-1 border text-[10px] uppercase tracking-wider ${log.status.includes('destroyed') ? 'border-rose-900 text-rose-500 bg-rose-950/30' : 'border-cyan-800 text-cyan-400 bg-cyan-950/30'}`}>
                            {log.status}
                          </span>
                        </td>
                        <td className="py-4 text-cyan-700">{new Date(log.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {statusMsg && <p className={`text-[10px] mt-4 text-center tracking-widest uppercase ${isError ? 'text-rose-500' : 'text-cyan-500'}`}> {statusMsg}</p>}
          </div>
        )}

        {/* --- VIEW: READ --- */}
        {view === "read" && (
          <div className="text-center space-y-8 animate-in slide-in-from-bottom-4 duration-500 py-8">
            <h2 className="text-2xl text-rose-500 tracking-[0.3em] uppercase drop-shadow-[0_0_15px_rgba(244,63,94,0.6)] animate-pulse">Encrypted Payload Detected</h2>
            <p className="text-[10px] text-cyan-600 uppercase tracking-widest">Provide decryption key to execute extraction.</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full max-w-sm mx-auto block bg-black border border-rose-900/50 py-3 text-center focus:outline-none focus:border-rose-500 text-rose-400 placeholder-rose-900 tracking-widest" placeholder="KEY REQUIRED" />
            <button onClick={handleRead} disabled={isLoading} className="w-full max-w-sm mx-auto block bg-rose-950/40 border border-rose-500/50 hover:bg-rose-900/60 hover:border-rose-400 disabled:opacity-50 text-rose-400 tracking-[0.3em] uppercase text-sm py-4 transition-all shadow-[inset_0_0_20px_rgba(244,63,94,0.1)] hover:shadow-[0_0_20px_rgba(244,63,94,0.4)]">
              {isLoading ? "BRUTE FORCING..." : "DECRYPT & EXTRACT"}
            </button>
            {statusMsg && <div className={`text-xs mt-4 text-center tracking-widest uppercase ${isError ? 'text-rose-500' : 'text-cyan-400'}`}> {statusMsg}</div>}
          </div>
        )}

        {/* --- VIEW: DECRYPTED RESULT --- */}
        {view === "decrypted" && (
          <div className="space-y-6 animate-in fade-in duration-700">
            <div className="bg-rose-950/20 border border-rose-900/50 p-3 rounded flex items-center justify-center animate-pulse">
                <span className="text-rose-500 text-[10px] tracking-[0.2em] uppercase font-bold">Warning: Data Extraction Complete. Trace Protocol Initiated.</span>
            </div>
            
            <label className="block text-[10px] text-cyan-600 uppercase tracking-widest">Decrypted Intel:</label>
            <textarea value={decryptedText} readOnly className="w-full h-32 bg-black border border-cyan-800 p-4 text-cyan-300 text-sm focus:outline-none resize-none font-mono" />
            
            {downloadInfo && (
              <div className="text-center bg-cyan-950/20 p-6 border border-cyan-800/50">
                <a href={downloadInfo.url} download={downloadInfo.name} className="inline-block bg-cyan-900/50 hover:bg-cyan-800/80 border border-cyan-500/50 text-cyan-300 tracking-[0.2em] uppercase text-xs py-3 px-8 transition-all shadow-[0_0_15px_rgba(6,182,212,0.2)]">Download Attached File</a>
              </div>
            )}
            {statusMsg && <p className="text-[10px] mt-6 text-center text-cyan-500 tracking-widest uppercase border-t border-cyan-900/30 pt-4"> {statusMsg}</p>}
          </div>
        )}

      </div>
    </main>
  );
}