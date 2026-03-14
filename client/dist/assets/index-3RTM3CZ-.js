const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/index-BmuYuH-L.js","assets/marked.esm-lwz-sxZg.js"])))=>i.map(i=>d[i]);
import{k as Y,D as re,A as p,b as o,o as Q}from"./marked.esm-lwz-sxZg.js";(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))i(a);new MutationObserver(a=>{for(const r of a)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&i(c)}).observe(document,{childList:!0,subtree:!0});function n(a){const r={};return a.integrity&&(r.integrity=a.integrity),a.referrerPolicy&&(r.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?r.credentials="include":a.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function i(a){if(a.ep)return;a.ep=!0;const r=n(a);fetch(a.href,r)}})();const ce="modulepreload",le=function(e){return"/"+e},F={},de=function(s,n,i){let a=Promise.resolve();if(n&&n.length>0){let m=function(d){return Promise.all(d.map(v=>Promise.resolve(v).then(S=>({status:"fulfilled",value:S}),S=>({status:"rejected",reason:S}))))};document.getElementsByTagName("link");const c=document.querySelector("meta[property=csp-nonce]"),u=c?.nonce||c?.getAttribute("nonce");a=m(n.map(d=>{if(d=le(d),d in F)return;F[d]=!0;const v=d.endsWith(".css"),S=v?'[rel="stylesheet"]':"";if(document.querySelector(`link[href="${d}"]${S}`))return;const g=document.createElement("link");if(g.rel=v?"stylesheet":ce,v||(g.as="script"),g.crossOrigin="",g.href=d,u&&g.setAttribute("nonce",u),document.head.appendChild(g),v)return new Promise((oe,ae)=>{g.addEventListener("load",oe),g.addEventListener("error",()=>ae(new Error(`Unable to preload CSS for ${d}`)))})}))}function r(c){const u=new Event("vite:preloadError",{cancelable:!0});if(u.payload=c,window.dispatchEvent(u),!u.defaultPrevented)throw c}return a.then(c=>{for(const u of c||[])u.status==="rejected"&&r(u.reason);return s().catch(r)})},pe=5,ue="(max-width: 900px)",w=window.matchMedia(ue),t={sessions:[],sessionsScope:"all",sessionsSearch:"",activeSession:void 0,availableModels:[],composerText:"",composerMode:"prompt",attachments:[],forkMessages:[],treeMessages:[],pendingExtensionUi:void 0,extensionUiValue:"",extensionNotifications:[],extensionStatuses:[],extensionWidgets:[],pageTitle:void 0,renameText:"",isLoading:!0,isLoadingForkMessages:!1,isLoadingTreeMessages:!1,isReopeningSession:!1,showMenu:!1,showModels:!1,showActions:!1,showTokenUsage:(localStorage.getItem("showTokenUsage")??"true")==="true",error:void 0,info:void 0,liveConnectionState:"disconnected",switchingSessionId:void 0,sidebarOpen:!w.matches,themeMode:localStorage.getItem("theme")||"system",colorTheme:localStorage.getItem("color-theme")||"ghostty",expandedGroups:new Set,expandedToolCards:new Set};let b,C,A=0;const E=["off","low","medium","high"];let q=null;const me=1e3,fe=1e4,z=new Map,J=new Map;Y.setOptions({breaks:!0,gfm:!0});async function ve(){D();try{await Promise.all([U(),ge()]),t.sessions[0]?.live?await W(t.sessions[0].id):t.sessions[0]?.sessionFile?await P(t.sessions[0].sessionFile):await X()}catch(e){Ce(M(e))}finally{t.isLoading=!1,l()}}async function U(e=t.sessionsScope){t.sessionsScope=e;const s=await T(`/api/sessions?scope=${e}`);t.sessions=s.sessions,l()}async function ge(){const e=await T("/api/models");t.availableModels=e.models}function $(e=t.sessionsScope){U(e).catch(s=>{t.error=M(s),l()})}async function X(){const e=await f("/api/sessions",{});h(e.snapshot),$()}async function Z(){await X(),te()}async function P(e){const s=await f("/api/sessions/open",{path:e});h(s.snapshot),$()}async function W(e){const s=await T(`/api/sessions/${e}`);h(s.snapshot)}async function he(){if(!t.activeSession||!t.composerText.trim()&&t.attachments.length===0)return;const e=t.composerText,s=[...t.attachments],n={message:e,images:s.map(a=>({fileName:a.fileName,mimeType:a.mimeType,data:a.data}))},i=t.activeSession.sessionId;await f(`/api/sessions/${i}/prompt`,n),t.composerText===e&&(t.composerText=""),(t.attachments===s||t.attachments.every((a,r)=>a.id===s[r]?.id))&&(t.attachments=[]),t.info=void 0,l()}async function be(){t.activeSession&&await f(`/api/sessions/${t.activeSession.sessionId}/abort`,{})}async function ye(){t.activeSession&&(await f(`/api/sessions/${t.activeSession.sessionId}/model/cycle`,{}),t.showModels=!1)}async function $e(e,s){t.activeSession&&(await f(`/api/sessions/${t.activeSession.sessionId}/model`,{provider:e,modelId:s}),t.showModels=!1)}async function Se(e){t.activeSession&&await f(`/api/sessions/${t.activeSession.sessionId}/thinking-level`,{thinkingLevel:e})}async function _(){if(t.activeSession){t.showActions=!0,t.showMenu=!1,t.renameText=t.activeSession.title,t.forkMessages=[],t.treeMessages=[],t.isLoadingForkMessages=!0,t.isLoadingTreeMessages=!0,l();try{const[e,s]=await Promise.all([T(`/api/sessions/${t.activeSession.sessionId}/fork-messages`),T(`/api/sessions/${t.activeSession.sessionId}/tree-messages`)]);t.forkMessages=e.messages,t.treeMessages=s.messages}catch(e){t.error=M(e)}finally{t.isLoadingForkMessages=!1,t.isLoadingTreeMessages=!1,l()}}}async function we(){if(!t.activeSession)return;const e=t.renameText.trim();if(!e)return;const s=await f(`/api/sessions/${t.activeSession.sessionId}/rename`,{name:e});h(s.snapshot),$(),t.info="Session renamed.",l()}async function xe(){if(!(!t.activeSession||t.isReopeningSession)){t.isReopeningSession=!0,l();try{const e=await f(`/api/sessions/${t.activeSession.sessionId}/reopen`,{});h(e.snapshot),$(),t.info="Session reloaded from disk."}catch(e){t.error=M(e)}finally{t.isReopeningSession=!1,l()}}}async function ke(e){if(!t.activeSession)return;const s=await f(`/api/sessions/${t.activeSession.sessionId}/fork`,{entryId:e});s.cancelled||(t.composerText=s.selectedText,t.showActions=!1,h(s.snapshot),$(),t.info="Fork created. The selected prompt was copied into the composer.",l())}async function Te(e){if(!t.activeSession)return;const s=await f(`/api/sessions/${t.activeSession.sessionId}/tree`,{entryId:e});s.cancelled||(t.composerText=s.editorText??"",t.showActions=!1,h(s.snapshot),$(),t.info=s.editorText?"Tree position changed. The selected prompt was copied into the composer.":"Tree position changed.",l())}async function Me(e){if(!e?.length)return;const{loadAttachment:s}=await de(async()=>{const{loadAttachment:r}=await import("./index-BmuYuH-L.js");return{loadAttachment:r}},__vite__mapDeps([0,1])),n=await Promise.all([...e].map(r=>s(r))),i=n.filter(r=>r.type==="image"),a=n.length-i.length;t.attachments=[...t.attachments,...i.map(r=>({id:r.id,fileName:r.fileName,mimeType:r.mimeType,preview:r.preview,data:r.content}))],a>0&&(t.info=`${a} non-image attachment(s) were skipped.`),l()}function h(e){const s=t.activeSession?.sessionId;t.activeSession=e,s!==e.sessionId&&(t.expandedToolCards=new Set),t.renameText=e.title,t.pendingExtensionUi=void 0,t.extensionUiValue="",t.extensionStatuses=[],t.extensionWidgets=[],t.pageTitle=e.title,document.title=t.pageTitle,t.error=void 0,t.isLoading=!1,t.switchingSessionId=void 0,t.liveConnectionState="connecting",Ee(e.sessionId),l(),ne()}function Ee(e){se(),b?.close();const s=new EventSource(`/api/sessions/${e}/events`);b=s,s.onopen=()=>{b===s&&(A=0,t.liveConnectionState="connected",l())},s.onmessage=n=>{if(b!==s)return;const i=JSON.parse(n.data);i.type==="snapshot"&&(t.activeSession=i.snapshot,t.renameText=i.snapshot.title,t.pageTitle=i.snapshot.title,document.title=i.snapshot.title,U()),i.type==="error"&&(t.error=i.message),i.type==="info"&&(t.info=i.message),i.type==="extension_ui_request"&&(t.pendingExtensionUi=i.request,t.extensionUiValue=i.request.prefill??""),i.type==="extension_notify"&&Ie(i.notification),i.type==="set_editor_text"&&(t.composerText=i.text),i.type==="set_status"&&Le(i.key,i.text),i.type==="set_widget"&&Ne(i.key,i.widget),i.type==="set_title"&&(t.pageTitle=i.title,document.title=i.title),l(),ne()},s.onerror=()=>{b===s&&(s.close(),b=void 0,t.liveConnectionState="reconnecting",l(),R(e))}}function Ce(e){t.error=e,l()}function Ie(e){t.extensionNotifications=[e,...t.extensionNotifications].slice(0,4),setTimeout(()=>{t.extensionNotifications=t.extensionNotifications.filter(s=>s.id!==e.id),l()},6e3).unref?.()}function Le(e,s){t.extensionStatuses=s?[{key:e,text:s},...t.extensionStatuses.filter(n=>n.key!==e)]:t.extensionStatuses.filter(n=>n.key!==e)}function Ne(e,s){t.extensionWidgets=s?[s,...t.extensionWidgets.filter(n=>n.key!==e)]:t.extensionWidgets.filter(n=>n.key!==e)}async function y(e){if(!t.activeSession||!t.pendingExtensionUi)return;const s=t.pendingExtensionUi.id;t.pendingExtensionUi=void 0,l(),await f(`/api/sessions/${t.activeSession.sessionId}/ui-response`,{id:s,value:e.value,confirmed:e.confirmed,cancelled:e.cancelled})}function D(){const e=document.documentElement;e.classList.remove("dark"),(t.themeMode==="dark"||t.themeMode==="system"&&matchMedia("(prefers-color-scheme: dark)").matches)&&e.classList.add("dark"),t.colorTheme!=="default"?e.setAttribute("data-color-theme",t.colorTheme):e.removeAttribute("data-color-theme")}function L(e){t.themeMode=e,localStorage.setItem("theme",e),D(),l()}function N(e){t.colorTheme=e,localStorage.setItem("color-theme",e),D(),l()}function Ae(){t.showTokenUsage=!t.showTokenUsage,localStorage.setItem("showTokenUsage",String(t.showTokenUsage)),l()}function x(){return w.matches}function Re(){t.sidebarOpen=!t.sidebarOpen,t.showMenu=!1,l()}function ee(){t.sidebarOpen&&(t.sidebarOpen=!1,l())}function te(){x()&&ee()}function B(e){t.sidebarOpen=!e.matches,document.getElementById("app")&&l()}function Oe(){return new Promise(e=>{requestAnimationFrame(()=>e())})}function Ue(e){return"Type a message..."}function se(){C&&(clearTimeout(C),C=void 0)}function R(e){se(),A+=1;const s=Math.min(me*2**Math.max(0,A-1),fe);C=setTimeout(()=>{Pe(e)},s)}async function Pe(e){const s=t.activeSession;if(s){try{await W(e);return}catch{if(!s.sessionFile){R(e);return}}try{await P(s.sessionFile)}catch{t.activeSession?.sessionFile===s.sessionFile&&R(e)}}}function ne(){requestAnimationFrame(()=>{const e=q??document.querySelector(".pp-messages");e&&(e.scrollTop=e.scrollHeight)})}function We(e){if(!e)return"";const s=/^\d+$/.test(e)?Number(e):e,n=new Date(s);if(Number.isNaN(n.getTime()))return"";const i=Date.now()-n.getTime(),a=Math.floor(i/1e3);if(a<60)return"just now";const r=Math.floor(a/60);if(r<60)return`${r}m ago`;const c=Math.floor(r/60);return c<24?`${c}h ago`:`${Math.floor(c/24)}d ago`}function _e(e){const s="/Users/kpovolotskyy";return e===s?"~":e.startsWith(s+"/")?"~/"+e.slice(s.length+1).toUpperCase():e}function k(e,s){const n=e.replace(/\s+/g," ").trim();return n.length<=s?n:`${n.slice(0,s-3)}…`}function De(e){return typeof e=="object"&&e!==null}function je(e){const s=e.trim();if(!s)return"";if(!(s.startsWith("{")&&s.endsWith("}")||s.startsWith("[")&&s.endsWith("]")))return e;try{return JSON.stringify(JSON.parse(s),null,2)}catch{return e}}function Fe(e){const s=e.trim();if(!(!s||!(s.startsWith("{")&&s.endsWith("}")||s.startsWith("[")&&s.endsWith("]"))))try{return JSON.parse(s)}catch{return}}function ze(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}function Je(e){return ze(e).replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,n=>{let i="pp-json-number";return n.startsWith('"')?i=n.endsWith(":")?"pp-json-key":"pp-json-string":n==="true"||n==="false"?i="pp-json-boolean":n==="null"&&(i="pp-json-null"),`<span class="${i}">${n}</span>`})}function I(e){const s=je(e).trim(),n=Fe(s);if(n!==void 0){const i=JSON.stringify(n,null,2)??"";return o`<pre class="pp-json-view">${Q(Je(i))}</pre>`}return o`<pre class="pp-tool-text">${s}</pre>`}function O(...e){return[t.activeSession?.sessionId??"no-session",...e].join(":")}function j(e,s){const n=s.currentTarget;n instanceof HTMLDetailsElement&&(n.open?t.expandedToolCards.add(e):t.expandedToolCards.delete(e),l())}function V(e){const s=e.trim();if(s){try{const n=JSON.parse(s);if(De(n)){const i=["command","path","prompt","message","query"];for(const a of i){const r=n[a];if(typeof r=="string"&&r.trim())return k(r,60)}}}catch{}return k(s.replace(/\s+/g," "),60)}}function ie(e){const s=z.get(e);if(s)return s;const i=e.replace(/\r\n/g,`
`).split(`
`),a=[];let r=[],c=0;const u=()=>{const d=r.join(`
`).trim();r=[],d&&a.push({type:"markdown",text:d})};for(;c<i.length;){const d=Be(i,c);if(!d){r.push(i[c]??""),c+=1;continue}u(),a.push({type:"toolCall",toolCall:d.message}),c=d.nextIndex}u();const m=a.length?a:[{type:"markdown",text:e}];return z.set(e,m),m}function Be(e,s){const n=e[s]?.trim().match(/^\[tool call:\s*([^\]]+)\]$/);if(!n)return;const i=n[1]?.trim();if(!i)return;let a=s+1;for(;a<e.length&&e[a]?.trim()==="";)a+=1;if(a>=e.length)return{message:{toolName:i,args:"",preview:void 0},nextIndex:a};const r=[];for(let m=a;m<e.length&&!e[m]?.trim().match(/^\[tool call:\s*[^\]]+\]$/);m+=1){r.push(e[m]??"");const d=r.join(`
`).trim();if(d&&(d.startsWith("{")&&d.endsWith("}")||d.startsWith("[")&&d.endsWith("]")))try{return JSON.parse(d),{message:{toolName:i,args:d,preview:V(d)},nextIndex:m+1}}catch{}}let c=a;for(;c<e.length&&!e[c]?.trim().match(/^\[tool call:\s*[^\]]+\]$/);)c+=1;const u=e.slice(a,c).join(`
`).trim();return{message:{toolName:i,args:u,preview:V(u)},nextIndex:c}}function Ve(e,s,n=[]){const i=e.preview?`${e.toolName} - ${e.preview}`:e.toolName,a=n.length===0?"call":n.length===1?"1 result":`${n.length} results`,r=t.expandedToolCards.has(s);return o`
    <details class="pp-tool-card" ?open=${r} @toggle=${c=>j(s,c)}>
      <summary class="pp-tool-summary">
        <span class="pp-tool-name">🛠 ${i}</span>
        <span class="pp-tool-status call">${a}</span>
      </summary>
      ${r?o`
            <div class="pp-tool-content">
              <div class="pp-tool-section">
                <div class="pp-tool-section-label">Call</div>
                <div class="pp-tool-section-body">${I(e.args||"No arguments")}</div>
              </div>
              ${n.map((c,u)=>Ge(c,u,n.length))}
            </div>
          `:p}
    </details>
  `}function Ge(e,s,n){const i=n===1?"Result":`Result ${s+1}`;return o`
    <div class="pp-tool-section pp-tool-section-result">
      <div class="pp-tool-section-label">${i}</div>
      <div class="pp-tool-section-body">${I(e)}</div>
    </div>
  `}function G(e){const s=J.get(e)??(()=>{const n=Y.parse(e,{async:!1});return J.set(e,n),n})();return o`<div class="pp-markdown">${Q(s)}</div>`}function He(){const e=t.sessionsSearch.trim().toLowerCase();return e?t.sessions.filter(s=>[s.title,s.preview,s.cwd,s.sessionFile].filter(i=>!!i).join(`
`).toLowerCase().includes(e)):t.sessions}function Ke(e){const s=new Map;for(const n of e){const i=n.cwd??n.sessionFile??"Unknown",a=s.get(i);a?a.push(n):s.set(i,[n])}return[...s.entries()].map(([n,i])=>({cwd:n,sessions:i,isCurrentWorkspace:i.some(a=>a.isInCurrentWorkspace)})).sort((n,i)=>{if(n.isCurrentWorkspace!==i.isCurrentWorkspace)return n.isCurrentWorkspace?-1:1;const a=Math.max(...n.sessions.map(c=>new Date(c.lastModified??0).getTime()));return Math.max(...i.sessions.map(c=>new Date(c.lastModified??0).getTime()))-a})}async function Ye(e){if(t.switchingSessionId!==e.id){if(t.activeSession?.sessionId===e.id&&e.live){te();return}t.switchingSessionId=e.id,t.isLoading=!0,t.error=void 0,t.info=void 0,x()&&(t.sidebarOpen=!1),l(),await Oe();try{if(e.live){await W(e.id);return}if(e.sessionFile){await P(e.sessionFile);return}}catch(s){t.error=M(s)}finally{const s=t.switchingSessionId===e.id||t.isLoading;t.switchingSessionId===e.id&&(t.switchingSessionId=void 0),t.isLoading=!1,s&&l()}}}function Qe(){if(!t.activeSession)return;const e=E.indexOf(t.activeSession.thinkingLevel),s=E[(e+1+E.length)%E.length]??"off";Se(s)}function qe(e){t.attachments=t.attachments.filter(s=>s.id!==e),l()}function l(){re(Ze(),document.getElementById("app")),q=document.querySelector(".pp-messages")}function Xe(e){const s=[];for(let n=0;n<e.length;n+=1){const i=e[n];if(i){if(i.role==="assistant"){const r=ie(i.text).filter(u=>u.type==="toolCall").length,c=[];if(r>0){const u=[];let m=n+1;for(;e[m]?.role==="toolResult";)u.push(e[m].text),m+=1;for(let d=0;d<r;d+=1){const v=u.length?[u.shift()]:[];d===r-1&&u.length&&v.push(...u.splice(0)),c.push(v)}c.some(d=>d.length>0)&&(n=m-1)}s.push(H(i,c));continue}s.push(H(i))}}return s}const Ze=()=>o`
  <div class="pp-shell">
    ${ct()}

    <!-- Header -->
    <header class="pp-header">
      <div class="pp-header-left">
        <button
          class="pp-header-icon-btn"
          @click=${Re}
          aria-label=${t.sidebarOpen?"Collapse sidebar":"Expand sidebar"}
          aria-expanded=${String(t.sidebarOpen)}
        >\u2630</button>
        <span class="pp-header-title">Pi Web</span>
      </div>
      <div class="pp-header-right">
        <button
          class="pp-header-new-btn"
          @click=${Z}
        >+ NEW</button>
        <button
          class="pp-header-icon-btn"
          @click=${()=>{t.showMenu=!t.showMenu,l()}}
          aria-label="Menu"
        >⋯</button>
      </div>
    </header>

    ${t.showMenu?ot():p}

    <!-- Body -->
    <div class="pp-body ${t.sidebarOpen?"sidebar-open":"sidebar-closed"} ${x()?"sidebar-overlay":"sidebar-docked"}">
      ${x()&&t.sidebarOpen?o`<button class="pp-sidebar-scrim" @click=${ee} aria-label="Close sidebar"></button>`:p}
      <!-- Sidebar -->
      <aside class="pp-sidebar ${x()?"mobile":"desktop"}" aria-hidden=${String(!t.sidebarOpen)}>
        <div class="pp-sidebar-search">
          <input
            type="text"
            placeholder="Search sessions\u2026"
            .value=${t.sessionsSearch}
            @input=${e=>{t.sessionsSearch=e.target.value,l()}}
          />
        </div>
        <div class="pp-sidebar-list">
          ${et()}
        </div>
      </aside>

      <!-- Main content -->
      <div class="pp-main">
        ${t.activeSession?.externallyDirty?at():p}

        ${t.error?o`<div class="pp-error" style="margin:0.75rem 1.5rem 0;">${t.error}</div>`:p}
        ${t.info?o`<div class="pp-info" style="margin:0.75rem 1.5rem 0;">${t.info}</div>`:p}

        <div class="pp-messages">
          ${t.isLoading?ut():t.activeSession?.messages.length?Xe(t.activeSession.messages):o`<div class="pp-empty">No messages yet. Start typing below.</div>`}

          ${t.activeSession?.toolExecutions.length?t.activeSession.toolExecutions.map(e=>it(e)):p}

          ${t.activeSession?.status==="streaming"?o`<div style="margin-bottom:0.5rem;"><span class="pp-streaming-cursor"></span></div>`:p}
        </div>

        ${K("aboveEditor")}

        <!-- Composer -->
        <div class="pp-composer">
          <label class="pp-composer-attach" title="Attach images">
            \ud83d\udcce
            <input
              type="file"
              accept="image/*"
              multiple
              @change=${e=>Me(e.target.files)}
            />
          </label>
          ${t.attachments.length?rt():p}
          <textarea
            class="pp-composer-input"
            rows="1"
            placeholder=${Ue()}
            .value=${t.composerText}
            @input=${e=>{t.composerText=e.target.value}}
            @keydown=${e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),he())}}
          ></textarea>
          ${t.activeSession?.status==="streaming"?o`<button
                style="background:none;border:none;color:var(--pp-error-text);cursor:pointer;font-size:1rem;flex-shrink:0;"
                @click=${be}
                title="Stop"
              >\u25a0</button>`:p}
        </div>

        ${K("belowEditor")}

        <!-- Status bar -->
        <div class="pp-statusbar">
          ${t.activeSession?o`<span class="pp-live-state ${t.liveConnectionState}">
                ${t.liveConnectionState==="connected"?"Live":t.liveConnectionState==="reconnecting"?"Reconnecting…":"Connecting…"}
              </span>`:p}
          ${t.extensionStatuses.map(e=>o`<span style="font-size:0.6875rem;">${e.key}: ${e.text}</span>`)}
          <button class="pp-statusbar-model" @click=${()=>{t.showModels=!0,l()}}>
            ${t.activeSession?.model?.name??"No model"}
          </button>
          <span class="pp-statusbar-icon" title="Thinking: ${t.activeSession?.thinkingLevel??"off"}">
            <button
              style="background:none;border:none;color:var(--pp-text-muted);cursor:pointer;font-size:0.75rem;"
              @click=${Qe}
              title="Cycle thinking level"
            >\ud83d\udca1</button>
          </span>
          ${t.showTokenUsage&&t.activeSession?o`<span class="pp-statusbar-stats">
                ${t.activeSession.messages.length} msgs
              </span>`:p}
        </div>
      </div>
    </div>

    <!-- Dialogs -->
    ${t.showModels?lt():p}
    ${t.showActions?dt():p}
    ${t.pendingExtensionUi?pt(t.pendingExtensionUi):p}
  </div>
`;function et(){const e=He();if(e.length===0)return o`<div style="padding:1rem 0.75rem;font-size:0.8125rem;color:var(--pp-text-muted);">No sessions match.</div>`;const s=Ke(e);return o`${s.map(n=>tt(n))}`}function tt(e){const s=_e(e.cwd),i=t.expandedGroups.has(e.cwd)?e.sessions.length:pe,a=e.sessions.slice(0,i),r=e.sessions.length-i;return o`
    <div class="pp-group-header">
      <span class="pp-group-label">${s}</span>
      <button class="pp-group-new" @click=${()=>st(e.cwd)}>+ NEW</button>
    </div>
    ${a.map(c=>nt(c))}
    ${r>0?o`<button class="pp-show-more" @click=${()=>{t.expandedGroups.add(e.cwd),l()}}>
          \u25be Show ${r} more\u2026
        </button>`:p}
  `}async function st(e){await Z()}function nt(e){const s=t.switchingSessionId===e.id,n=t.switchingSessionId?s:t.activeSession?.sessionId===e.id;return o`
    <button
      class="pp-session-item ${n?"active":""} ${s?"loading":""}"
      @click=${()=>Ye(e)}
      ?disabled=${s}
      aria-busy=${String(s)}
    >
      <div class="pp-session-dot ${e.live||e.status==="streaming"?"live":"idle"}"></div>
      <div class="pp-session-info">
        <div class="pp-session-title">${k(e.title,60)}</div>
        <div class="pp-session-meta">
          <span class="pp-session-time">${s?"Opening…":We(e.lastModified)}</span>
          <span class="pp-session-badge">${e.messageCount}</span>
        </div>
      </div>
      <div class="pp-session-actions">
        <button
          class="pp-session-action-btn"
          @click=${i=>{i.stopPropagation(),_()}}
          title="Actions"
        >\u2699</button>
      </div>
    </button>
  `}function H(e,s=[]){if(e.role==="user"||e.role==="user-with-attachments")return o`
      <div style="margin-bottom:0.75rem;">
        <div class="pp-msg-user">
          <div class="pp-msg-user-label">YOU</div>
          <div class="pp-msg-user-text">${e.text}</div>
        </div>
      </div>
    `;if(e.role==="assistant"){const n=ie(e.text);let i=0;return o`${n.map((a,r)=>{if(a.type==="toolCall"){const c=i++;return Ve(a.toolCall,O("message",e.id,"tool-call",String(r)),s[c]??[])}return o`
        <div class="pp-msg-assistant">
          ${G(a.text)}
        </div>
      `})}`}if(e.role==="toolResult"){const n=O("message",e.id,"tool-result"),i=t.expandedToolCards.has(n);return o`
      <details
        class="pp-tool-card"
        style="margin-bottom:0.5rem;"
        ?open=${i}
        @toggle=${a=>j(n,a)}
      >
        <summary class="pp-tool-summary">
          <span class="pp-tool-name">\ud83d\udee0 Tool result</span>
        </summary>
        ${i?o`<div class="pp-tool-content">${I(e.text)}</div>`:p}
      </details>
    `}return o`
    <div class="pp-msg-assistant" style="opacity:0.85;">
      <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;color:var(--pp-text-muted);margin-bottom:0.125rem;">
        ${e.role}
      </div>
      ${G(e.text)}
    </div>
  `}function it(e){const s=O("execution",e.toolCallId),n=e.status==="running"||t.expandedToolCards.has(s);return o`
    <details class="pp-tool-card" ?open=${n} @toggle=${i=>j(s,i)}>
      <summary class="pp-tool-summary">
        <span class="pp-tool-name">${e.toolName}</span>
        <span class="pp-tool-status ${e.status}">${e.status}</span>
      </summary>
      ${n?o`<div class="pp-tool-content">${e.text?I(e.text):"Running…"}</div>`:p}
    </details>
  `}function ot(){return o`
    <div class="pp-menu-overlay" @click=${()=>{t.showMenu=!1,l()}}>
      <div class="pp-menu" @click=${e=>e.stopPropagation()}>
        <button class="pp-menu-item" @click=${_}>
          \u2699\ufe0f Settings
        </button>
        <button class="pp-menu-item" @click=${Ae}>
          $ Token usage ${t.showTokenUsage?o`<span class="check">\u2713</span>`:p}
        </button>
        <div class="pp-menu-divider"></div>
        <div class="pp-menu-section">Color Theme</div>
        <button class="pp-menu-item" @click=${()=>N("default")}>
          Default ${t.colorTheme==="default"?o`<span class="check">\u2713</span>`:p}
        </button>
        <button class="pp-menu-item" @click=${()=>N("gruvbox")}>
          Gruvbox ${t.colorTheme==="gruvbox"?o`<span class="check">\u2713</span>`:p}
        </button>
        <button class="pp-menu-item" @click=${()=>N("ghostty")}>
          Ghostty ${t.colorTheme==="ghostty"?o`<span class="check">\u2713</span>`:p}
        </button>
        <div class="pp-menu-divider"></div>
        <div class="pp-menu-section">Appearance</div>
        <button class="pp-menu-item" @click=${()=>L("light")}>
          \u2600\ufe0f Light ${t.themeMode==="light"?o`<span class="check">\u2713</span>`:p}
        </button>
        <button class="pp-menu-item" @click=${()=>L("dark")}>
          \ud83c\udf19 Dark ${t.themeMode==="dark"?o`<span class="check">\u2713</span>`:p}
        </button>
        <button class="pp-menu-item" @click=${()=>L("system")}>
          \ud83d\udcbb System ${t.themeMode==="system"?o`<span class="check">\u2713</span>`:p}
        </button>
      </div>
    </div>
  `}function at(){return o`
    <div class="pp-external-banner">
      <span>Session changed outside web. </span>
      <button @click=${xe} ?disabled=${t.isReopeningSession}>
        ${t.isReopeningSession?"Reloading…":"Reload from disk"}
      </button>
      <button @click=${_}>Actions</button>
    </div>
  `}function rt(){return o`
    <div class="pp-attachments">
      ${t.attachments.map(e=>o`
          <div class="pp-attachment-thumb">
            ${e.preview?o`<img src="data:${e.mimeType};base64,${e.preview}" alt=${e.fileName} />`:o`<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:0.5rem;color:var(--pp-text-muted);">IMG</div>`}
            <button class="pp-attachment-remove" @click=${()=>qe(e.id)}>\u00d7</button>
          </div>
        `)}
    </div>
  `}function K(e){const s=t.extensionWidgets.filter(n=>n.placement===e);return s.length===0?p:o`
    <div style="padding:0 1rem;">
      ${s.map(n=>o`
          <div style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--pp-border);border-radius:0.375rem;background:var(--pp-bg-secondary);">
            <div style="font-size:0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--pp-text-muted);margin-bottom:0.25rem;">${n.key}</div>
            <pre style="font-size:0.75rem;line-height:1.5;color:var(--pp-text-muted);white-space:pre-wrap;word-break:break-word;margin:0;">${n.lines.join(`
`)}</pre>
          </div>
        `)}
    </div>
  `}function ct(){return t.extensionNotifications.length===0?p:o`
    <div class="pp-toasts">
      ${t.extensionNotifications.map(e=>o`
        <div class="pp-toast ${e.notifyType}">
          <div class="pp-toast-type">${e.notifyType}</div>
          <div>${e.message}</div>
        </div>
      `)}
    </div>
  `}function lt(){return o`
    <div class="pp-dialog-overlay" @click=${()=>{t.showModels=!1,l()}}>
      <div class="pp-dialog" @click=${e=>e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Models</div>
          <div style="display:flex;gap:0.375rem;">
            <button class="pp-dialog-btn" @click=${ye}>Cycle</button>
            <button class="pp-dialog-btn" @click=${()=>{t.showModels=!1,l()}}>Done</button>
          </div>
        </div>
        ${t.availableModels.map(e=>o`
            <button class="pp-dialog-item" @click=${()=>$e(e.provider,e.id)}>
              <div class="pp-dialog-item-title">${e.name}</div>
              <div class="pp-dialog-item-desc">${e.provider}/${e.id}</div>
            </button>
          `)}
      </div>
    </div>
  `}function dt(){return o`
    <div class="pp-dialog-overlay" @click=${()=>{t.showActions=!1,l()}}>
      <div class="pp-dialog" @click=${e=>e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Session actions</div>
          <button class="pp-dialog-btn" @click=${()=>{t.showActions=!1,l()}}>Done</button>
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Rename session</div>
          <div class="pp-dialog-section-desc">Set a persistent display name.</div>
          <input
            class="pp-dialog-input"
            style="margin-bottom:0.5rem;"
            .value=${t.renameText}
            @input=${e=>{t.renameText=e.target.value}}
            placeholder="Refactor auth module"
          />
          <button class="pp-dialog-btn" @click=${we}>Save name</button>
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Navigate tree</div>
          <div class="pp-dialog-section-desc">Jump to an earlier prompt inside the same session.</div>
          ${t.isLoadingTreeMessages?o`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">Loading\u2026</div>`:t.treeMessages.length?t.treeMessages.map(e=>o`
                    <button class="pp-dialog-item" @click=${()=>Te(e.entryId)}>
                      <div class="pp-dialog-item-title">${k(e.text,120)}</div>
                      <div class="pp-dialog-item-desc">
                        ${e.isOnCurrentPath?"current path • ":""}Switch inside this session
                      </div>
                    </button>
                  `):o`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">No prompts for tree navigation yet.</div>`}
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Fork from earlier prompt</div>
          <div class="pp-dialog-section-desc">Create a new session from a previous message.</div>
          ${t.isLoadingForkMessages?o`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">Loading\u2026</div>`:t.forkMessages.length?t.forkMessages.map(e=>o`
                    <button class="pp-dialog-item" @click=${()=>ke(e.entryId)}>
                      <div class="pp-dialog-item-title">${k(e.text,120)}</div>
                      <div class="pp-dialog-item-desc">Create a separate session</div>
                    </button>
                  `):o`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">No prompts for forking yet.</div>`}
        </div>
      </div>
    </div>
  `}function pt(e){return o`
    <div class="pp-dialog-overlay" @click=${()=>y({cancelled:!0})}>
      <div class="pp-dialog" @click=${s=>s.stopPropagation()}>
        <div class="pp-dialog-title">${e.title}</div>
        ${e.message?o`<div class="pp-dialog-subtitle">${e.message}</div>`:p}
        ${e.timeout?o`<div style="font-size:0.75rem;color:var(--pp-text-muted);margin-bottom:0.5rem;">Expires in ~${Math.ceil(e.timeout/1e3)}s</div>`:p}

        ${e.method==="select"?o`${e.options?.map(s=>o`
                <button class="pp-dialog-item" @click=${()=>y({value:s})}>
                  ${s}
                </button>
              `)}`:p}

        ${e.method==="confirm"?o`
              <div style="display:flex;gap:0.375rem;">
                <button class="pp-dialog-btn" style="flex:1;" @click=${()=>y({cancelled:!0})}>Cancel</button>
                <button class="pp-dialog-btn primary" style="flex:1;" @click=${()=>y({confirmed:!0})}>Confirm</button>
              </div>
            `:p}

        ${e.method==="input"||e.method==="editor"?o`
              ${e.method==="input"?o`<input
                    class="pp-dialog-input"
                    style="margin-bottom:0.5rem;"
                    .value=${t.extensionUiValue}
                    @input=${s=>{t.extensionUiValue=s.target.value,l()}}
                    placeholder=${e.placeholder??""}
                  />`:o`<textarea
                    class="pp-dialog-input"
                    style="margin-bottom:0.5rem;min-height:10rem;font-family:monospace;"
                    .value=${t.extensionUiValue}
                    @input=${s=>{t.extensionUiValue=s.target.value,l()}}
                    placeholder=${e.placeholder??""}
                  ></textarea>`}
              <div style="display:flex;gap:0.375rem;">
                <button class="pp-dialog-btn" style="flex:1;" @click=${()=>y({cancelled:!0})}>Cancel</button>
                <button class="pp-dialog-btn primary" style="flex:1;" @click=${()=>y({value:t.extensionUiValue})}>Submit</button>
              </div>
            `:p}
      </div>
    </div>
  `}function ut(){return o`
    <div style="padding:1rem 0;">
      ${[80,65,90].map(e=>o`
          <div style="margin-bottom:0.75rem;">
            <div class="pp-skeleton-bar" style="width:${e}%;height:0.75rem;margin-bottom:0.375rem;"></div>
            <div class="pp-skeleton-bar" style="width:${e-20}%;height:0.625rem;"></div>
          </div>
        `)}
    </div>
  `}async function T(e){const s=await fetch(e,{credentials:"same-origin"});if(!s.ok)throw new Error(await s.text());return await s.json()}async function f(e,s){const n=await fetch(e,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(s)});if(!n.ok)throw new Error(await n.text());return await n.json()}function M(e){return e instanceof Error?e.message:String(e)}typeof w.addEventListener=="function"?w.addEventListener("change",B):w.addListener(B);await ve();
