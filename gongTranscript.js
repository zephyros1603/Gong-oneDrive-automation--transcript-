/**
 * Convert a Gong /call/detailed-transcript JSON payload into readable text.
 *
 * Works in Node and in the browser. Node also exposes a CLI:
 *
 *   node gongTranscript.js transcript.json
 *   node gongTranscript.js transcript.json -o call.txt
 *   node gongTranscript.js transcript.json --format srt
 *   node gongTranscript.js transcript.json --no-timestamps --full-names
 *
 * As a module:
 *
 *   import { convert, extractTurns } from './gongTranscript.js';
 *   const text = convert(json, { format: 'md', fullNames: true });
 */

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

/**
 * Gong IDs are 19-digit integers, well past Number.MAX_SAFE_INTEGER
 * (9007199254740991). A plain JSON.parse silently rounds them:
 * 2800017128684783250 becomes 2800017128684783000. So quote long integer
 * values on the ID keys before parsing, keeping them as exact strings.
 *
 * This is why you should hand load() the raw JSON *text*. If you call
 * JSON.parse yourself and pass the object, the digits are already gone.
 */
const BIG_ID_KEYS = /"(callId|companyId|speakerId|id)"\s*:\s*(\d{16,})/g;

/** Accept a parsed object or a JSON string (string is preferred — see above). */
export function load(source) {
  if (typeof source === 'string') {
    return JSON.parse(source.replace(BIG_ID_KEYS, '"$1":"$2"'));
  }
  if (source && typeof source === 'object') return source;
  throw new TypeError('load() expects a JSON string or a parsed object');
}

/** seconds -> '4:07' / '1:04:07' (short), '00:04:07,120' (srt), '00:04:07.120' (vtt) */
export function fmtTime(seconds, style = 'short') {
  if (seconds == null || Number.isNaN(Number(seconds))) return '';
  const total = Math.max(0, Number(seconds));
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ms = Math.round((total - whole) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');

  if (style === 'srt') return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
  if (style === 'vtt') return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(ms)}`;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

/** Tidy raw ASR text: collapse whitespace, remove space before punctuation. */
export function clean(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([,.!?;:])/g, '$1');
}

/**
 * Map speakerId -> display name.
 *
 * Gong puts short names in `shortNamesLookup` ("Sanjan") and full names in the
 * participant lists. With fullNames, a short name is matched to a participant
 * whose fullName starts with it, falling back to the short name when there is
 * no match (participants who never speak are listed but never referenced).
 */
export function buildNameMap(data, fullNames = false) {
  const short = {};
  for (const [k, v] of Object.entries(data.shortNamesLookup || {})) {
    short[String(k)] = v;
  }
  if (!fullNames) return short;

  const people = [
    ...(data.companyParticipants || []),
    ...Object.values(data.customerParticipants || {}).flat(),
    ...(data.unknownParticipants || []),
  ];

  const resolved = {};
  for (const [sid, nick] of Object.entries(short)) {
    const match = people.find((p) =>
      (p.fullName || '').toLowerCase().startsWith(String(nick).toLowerCase())
    );
    resolved[sid] = match
      ? match.companyName
        ? `${match.fullName} (${match.companyName})`
        : match.fullName
      : nick;
  }
  return resolved;
}

/** Best-effort end time: the last word's `end`, else the start timestamp. */
export function monologueEnd(mono) {
  const terms = mono?.monologueWords?.terms || [];
  const ends = terms.map((t) => t.end).filter((e) => e != null);
  return ends.length ? Math.max(...ends) : mono?.timestamp;
}

/**
 * Flatten monologues into turns: { speaker, start, end, time, text }.
 *
 * Gong frequently splits one continuous stretch of speech across several
 * monologues, so consecutive same-speaker entries are stitched together
 * unless merge is false.
 */
export function extractTurns(data, { fullNames = false, merge = true } = {}) {
  const names = buildNameMap(data, fullNames);
  const turns = [];

  for (const mono of data.monologues || []) {
    const text = clean(mono.text);
    if (!text) continue;

    const sid = String(mono.speakerId ?? '');
    const speaker = names[sid] || mono.speakerName || 'Unknown';
    const last = turns[turns.length - 1];

    if (merge && last && last.speaker === speaker) {
      last.text += ' ' + text;
      last.end = monologueEnd(mono);
      continue;
    }

    turns.push({
      speaker,
      start: mono.timestamp,
      end: monologueEnd(mono),
      time: mono.timestampStr || fmtTime(mono.timestamp),
      text,
    });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

function header(data) {
  const title = data.callTitle || 'Untitled call';
  const dur = `${data.durationHours || 0}h ${data.durationMinutes || 0}m`
    .replace(/^0h\s*/, '')
    .trim();

  const lines = [
    title,
    '='.repeat(title.length),
    `Date:        ${data.when || ''}`,
    `Duration:    ${dur}`,
    `Account:     ${data.callCustomers || ''}`,
    `Organizer:   ${data.callOrganizerName || ''}`,
    `Platform:    ${data.callMeetingProvider || ''}`,
    `Call ID:     ${data.callId || ''}`,
  ];

  const people = [
    ...(data.companyParticipants || []),
    ...Object.values(data.customerParticipants || {}).flat(),
  ].map((p) => `  - ${p.fullName} — ${p.title || ''}, ${p.companyName || ''}`);

  if (people.length) lines.push('', 'Participants:', ...people);
  return lines.join('\n') + '\n';
}

export function toText(data, opts = {}) {
  const {
    timestamps = true,
    fullNames = false,
    merge = true,
    includeHeader = true,
  } = opts;

  const turns = extractTurns(data, { fullNames, merge });
  const out = includeHeader ? [header(data)] : [];

  for (const t of turns) {
    const label = timestamps
      ? `[${t.time}] ${t.speaker}:`
      : `${t.speaker}:`;
    out.push(`${label}\n${t.text}\n`);
  }
  return out.join('\n').trimEnd() + '\n';
}

export function toMarkdown(data, opts = {}) {
  const { timestamps = true, fullNames = false, merge = true } = opts;
  const turns = extractTurns(data, { fullNames, merge });

  const out = [
    `# ${data.callTitle || 'Call transcript'}`,
    '',
    `**${data.when || ''}** · ${data.durationMinutes || 0} min · ` +
      `${data.callCustomers || ''} · ${data.callMeetingProvider || ''}`,
    '',
  ];

  for (const t of turns) {
    const stamp = timestamps ? `\`${t.time}\` ` : '';
    out.push(`**${stamp}${t.speaker}**`, '', t.text, '');
  }
  return out.join('\n');
}

function cueTimes(t) {
  const start = t.start || 0;
  const end = t.end && t.end > start ? t.end : start + 2;
  return [start, end];
}

export function toSrt(data, opts = {}) {
  const { fullNames = false, merge = true } = opts;
  return extractTurns(data, { fullNames, merge })
    .map((t, i) => {
      const [start, end] = cueTimes(t);
      return (
        `${i + 1}\n` +
        `${fmtTime(start, 'srt')} --> ${fmtTime(end, 'srt')}\n` +
        `${t.speaker}: ${t.text}\n`
      );
    })
    .join('\n');
}

export function toVtt(data, opts = {}) {
  const { fullNames = false, merge = true } = opts;
  const out = ['WEBVTT', ''];
  for (const t of extractTurns(data, { fullNames, merge })) {
    const [start, end] = cueTimes(t);
    out.push(`${fmtTime(start, 'vtt')} --> ${fmtTime(end, 'vtt')}`);
    out.push(`<v ${t.speaker}>${t.text}`);
    out.push('');
  }
  return out.join('\n');
}

/** One-call entry point. Returns the rendered transcript as a string. */
export function convert(source, opts = {}) {
  const data = load(source);
  switch (opts.format || 'text') {
    case 'text': return toText(data, opts);
    case 'md':   return toMarkdown(data, opts);
    case 'srt':  return toSrt(data, opts);
    case 'vtt':  return toVtt(data, opts);
    default:     throw new Error(`unknown format: ${opts.format}`);
  }
}

// ---------------------------------------------------------------------------
// browser helper
// ---------------------------------------------------------------------------

/** Fetch a call's transcript from the Gong tab you're signed into and render it. */
export async function fetchTranscript(callId, opts = {}) {
  const res = await fetch(`/call/detailed-transcript?call-id=${callId}`, {
    credentials: 'include',
    headers: { accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error(`Gong returned HTTP ${res.status}`);
  // text(), not json() — see the note on BIG_ID_KEYS above.
  return convert(await res.text(), opts);
}

// ---------------------------------------------------------------------------
// cli (node only)
// ---------------------------------------------------------------------------

const isNodeCli =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isNodeCli) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const argv = process.argv.slice(2);

  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(
      'Usage: node gongTranscript.js <transcript.json> [-o out] ' +
        '[-f text|md|srt|vtt] [--no-timestamps] [--full-names] ' +
        '[--no-merge] [--no-header]'
    );
    process.exit(argv.length ? 0 : 1);
  }

  const flag = (...names) => argv.some((a) => names.includes(a));
  const value = (...names) => {
    const i = argv.findIndex((a) => names.includes(a));
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const input = argv.find((a) => !a.startsWith('-') &&
    argv[argv.indexOf(a) - 1] !== '-o' &&
    argv[argv.indexOf(a) - 1] !== '--output' &&
    argv[argv.indexOf(a) - 1] !== '-f' &&
    argv[argv.indexOf(a) - 1] !== '--format');

  const result = convert(readFileSync(input, 'utf8'), {
    format: value('-f', '--format') || 'text',
    timestamps: !flag('--no-timestamps'),
    fullNames: flag('--full-names'),
    merge: !flag('--no-merge'),
    includeHeader: !flag('--no-header'),
  });

  const out = value('-o', '--output');
  if (out) {
    writeFileSync(out, result, 'utf8');
    console.error(`Wrote ${out} (${result.length.toLocaleString()} chars)`);
  } else {
    process.stdout.write(result);
  }
}


// curl 'https://us-81357.app.gong.io/call/detailed-transcript?call-id=2800017128684783250' \
//   -H 'accept: application/json, text/plain, */*' \
//   -H 'referer: https://us-81357.app.gong.io/call?id=2800017128684783250' \
//   -H 'cookie: _ga=GA1.1.1682244868.1773914615; ajs_anonymous_id=0e0692c6-bc5e-430e-8250-348880375ec3; email-tracking=tjoJ+oR9kUzk6oS0ZpOlxAodIISa6UEddDZleRhoFB0=; _gcl_au=1.1.665481554.1783590354; mkjs_user_id=null; mkjs_group_id=null; _lfa=LF1.1.3160d0b2de6559a9.1783590354283; dd_group_id=3295967034453654500; _mkto_trk=id:185-VCR-682&token:_mch-gong.io-d9ef98db9c957c84a18ffff6580c9278; _tt_enable_cookie=1; _ttp=01KX34A00SCM00NH9SNR4H19PH_.tt.1; _hjSessionUser_2152431=eyJpZCI6IjE4Njc0OTFmLTAwNDgtNWJhMy05OWFlLTk5Njk4YTgyYzFhNSIsImNyZWF0ZWQiOjE3ODM1OTAzNTQ5OTAsImV4aXN0aW5nIjp0cnVlfQ==; _cq_duid=1.1783590355.aEgePG8c1B1Sb9NB; _biz_uid=3984f5d9f518461fee47a6e294f869b9; _biz_flagsA=%7B%22Version%22%3A1%2C%22ViewThrough%22%3A%221%22%2C%22Mkto%22%3A%221%22%2C%22XDomain%22%3A%221%22%7D; cb_user_id=null; cb_group_id=null; cb_anonymous_id=%221c6f9305-1700-4d05-ac68-66cdb607ca89%22; __q_state_BfkvrPMxzPRCWCSS=eyJ1dWlkIjoiNDhkNGVlNDktYjEwYy00YWFjLThmNjYtNjRkYTIwNzgwNjU1IiwiY29va2llRG9tYWluIjoiZ29uZy5pbyIsIm1lc3NlbmdlckV4cGFuZGVkIjpudWxsLCJwcm9tcHREaXNtaXNzZWQiOmZhbHNlLCJjb252ZXJzYXRpb25JZCI6bnVsbH0=; ph_phc_cSRzssB66GMS2pIraPNvkQ73Am9Eh9XavlkKPLczzuy_posthog=%7B%22%24device_id%22%3A%22019f4644-fe91-738f-83d2-2e758633a089%22%2C%22distinct_id%22%3A%22019f4644-fe91-738f-83d2-2e758633a089%22%2C%22%24sesid%22%3A%5B1783590365766%2C%22019f4644-fe95-74dd-84bf-fc601c5bcfac%22%2C1783590354580%5D%2C%22%24initial_person_info%22%3A%7B%22r%22%3A%22https%3A%2F%2Fwww.google.com%2F%22%2C%22u%22%3A%22https%3A%2F%2Fwww.gong.io%2Fabout%22%7D%2C%22%24user_state%22%3A%22anonymous%22%7D; ajs_group_id=3295967034453654596; last-login=eyJhbGciOiJIUzI1NiJ9.eyJzdCI6IlRPVkxRVzMyWEEyVTdRWURQWEE2VFE1QVROU0xEQ0RJSUNNVFFLU0hRTkQ0SVhBUzRaVjUzQjVQU1FaWkxBU1RGSEJFQ0IyT0c0WFBUT0VXQzNYVUNYU0tRSkhSWUFaQVdOUjJaVkEiLCJncCI6Ik9mZmljZTM2NSIsImV4cCI6MTc5MDE2MTIxOSwiaWF0IjoxNzg3NTY5MjE5LCJqdGkiOiJoekNqTnRhMjJ4b0oiLCJndSI6InNhbmphbi5hdGh5YWR5QGFxdWVyYS5jb20ifQ.26nZ2OhNt2nmFrcHJGo2KdQJjPNJpBrPtFoRhzIiKGQ; cell=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTAxNjEyMTksImNlbGwiOiJ1cy04MTM1NyIsImlhdCI6MTc4NzU2OTIxOSwianRpIjoiS3RiQXoydmp4ZWFWIiwiZ3UiOiJzYW5qYW4uYXRoeWFkeUBhcXVlcmEuY29tIn0.VUrPSQ6X0TDa-GklZV2ITdgaBsngbaxDjgEsKxIsaa4; rxVisitorj6unls01=17875692238036T8CJNJ5PH7TGK7OGQJ95MKA2RQCID69; amplitude_idundefinedgong.io=eyJvcHRPdXQiOmZhbHNlLCJzZXNzaW9uSWQiOm51bGwsImxhc3RFdmVudFRpbWUiOm51bGwsImV2ZW50SWQiOjAsImlkZW50aWZ5SWQiOjAsInNlcXVlbmNlTnVtYmVyIjowfQ==; dtCookiej6unls01=v_4_srv_20_sn_3UVG5C4RQQVL7FI90QSS8I7QCKV52SDF_app-3Ae13e4678422d588c_1_ol_0_perc_100000_mul_1; OptanonConsent=isGpcEnabled=0&datestamp=Mon+Aug+31+2026+17%3A39%3A21+GMT%2B0530+(India+Standard+Time)&version=202512.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=b7d40ac2-fdc5-4e4d-9b6a-8ca72ae2ee63&interactionCount=2&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&intType=3&crTime=1783590356791&geolocation=IN%3BKA&AwaitingReconsent=false; OptanonAlertBoxClosed=2026-08-31T12:09:21.208Z; _rdt_uuid=1783590353831.70f3ba03-596f-4263-84cc-a320b19d99e3; _uetvid=fa626e407b7a11f1bb4f83265ec09f2d; _biz_nA=4; _pvd_uid=1.11-h5b0xb6c-mth73wac; _biz_pendingA=%5B%5D; _cq_suid=1.1788178162.H5KceOlXgvbZns7n; _cq_session=2.1788178162782.TDNmHf0vSU9eQRx1.1788178162782; ttcsid=1788178162231::mNcPqP131aI5IXawgAU7.2.1788178162790.0::1.-2747.0::0.0.0.0::0.0.0; ttcsid_CO1FNSJC77U4A9P35NG0=1788178162229::xBJlHE0Cinfu_qST0Ixl.2.1788178162790.0; __obref=a2f34d38-0317-4dc5-bc07-07d22d536f59; _ga_3917TCG929=GS2.1.s1788178161$o9$g0$t1788178162$j59$l0$h0; _ga_6N7HLHKY8X=GS2.1.s1788178161$o9$g0$t1788178162$j59$l0$h0; analytics_session_id=1788261836310; analytics_session_id.last_access=1788261836310; fs_uid=#o-24G31A-na1#31a81106-345c-452c-a818-65335df16250:b6a90896-3d8f-4fd1-b11a-0d9da13cd45a:1788261835646::1####/1819714172; _ga_386971600=GS2.1.s1788274636$o3$g0$t1788274636$j60$l0$h0; ajs_user_id=4837246324148864338; g-session=Z3Nlc3NfYzI0MjdmZGEtNTM5My00YTMxLWEzNTgtZTUzZWU2YmRlYWM0; cf_clearance=j8Q2UfqAFJjUAkARR79RaW8T45Drjy1Vkxlr7cCrFDg-1788439914-1.2.1.1-fJVEAiqXG7qOc.kt4pbq2_WRsZU.t3x7k.qy.aAn4x8LeinTXxGSQsVfuucasyXsFIe6ymkwA0d4gf.j_KmbLOO_EYCtW1pqDMnpCrywrOo8pFM4kERfkGNUCeYuAPaEpHF.trnAGYSGYoGZhObp7.s6Wd4wNapGErH4OBfYxJJetMft6ae13EU5DkADgy3wx5Q8_rFmBjOuNKZ8DIA9q7Xl6RFcmt55BZuGIcnyjyvCp2DPIENeOeftdtcDXeuEDDCnhByVn1CAt4S8d7SlEPL82iTgro7cESQgDWCHZ7nqd3_GhExKLj0REr79NNOCS4eXGv8MJbXmDpIxf1pPILpaRxmApH8B7kY0TYFO7LU; __cf_bm=em8A6JmkbfFHmy4GTGSJqhJ8GozTA8Hkzx6jJOiI7d8-1788439914.2088923-1.0.1.1-hEsR94TNbtpxhKOuW.XW2qcDACsESWAZtIrfjco1eEDxV2z5Crw.vN6FjUPortLXI6pTBI24f9f4u7vzeJYOO6Kjj17BCPZImzNFNwUnN9IEPcgQS4_ZcrHoxTqx5DzH; dtSaj6unls01=-; rxvtj6unls01=1788441891542|1788439898714; dtPCj6unls01=20$440055855_155h-vKHVJWKWRNFAGTQMOUACIDCJLSKRCDJUH-0e0; amplitude_id_62c2f60d13da65a8cb3304a439aa6128gong.io=eyJkZXZpY2VJZCI6IjA2ZmM5MmY2LWNiY2ItNDUzNi1iMmY0LWZmOTQwMWJiYjJlNVIiLCJ1c2VySWQiOiI0ODM3MjQ2MzI0MTQ4ODY0MzM4Iiwib3B0T3V0IjpmYWxzZSwic2Vzc2lvbklkIjoxNzg4NDM5OTE2MjUyLCJsYXN0RXZlbnRUaW1lIjoxNzg4NDQwMjQyMTA4LCJldmVudElkIjozMjY3LCJpZGVudGlmeUlkIjo2MzQsInNlcXVlbmNlTnVtYmVyIjozOTAxfQ==; AWSALBTG=oD07+JgScWMMw5rzW2xAm/a0e6pkGW2ErbbSVB+lisb2ycUkpy3AEf4hN8YMscFZhM6hBXGTOPB7CyB44xgiDqJc02n1qBzHmgH7vGkNZKh/cicsIzBSrSY1cI9VJ45yMBafK8ncvWptNQWUXLJjcfUftor3OfA06NhHl5UWDGKq4ciCalWLXKEqwGtHgMBspW5c23r1Lkpdzn+GN9WrgInUem2otqa4Hxj3lim135ilOsaXhlCLWjD2k/S4D1lp6Or+SWuQWYikEYmloeW1KJl5BXrWKVIsrDj5tln3t7z5wx/f6naPPXgBgGj/uiHnSJYSbY80iQR1uYM+qaLi; AWSALBTGCORS=oD07+JgScWMMw5rzW2xAm/a0e6pkGW2ErbbSVB+lisb2ycUkpy3AEf4hN8YMscFZhM6hBXGTOPB7CyB44xgiDqJc02n1qBzHmgH7vGkNZKh/cicsIzBSrSY1cI9VJ45yMBafK8ncvWptNQWUXLJjcfUftor3OfA06NhHl5UWDGKq4ciCalWLXKEqwGtHgMBspW5c23r1Lkpdzn+GN9WrgInUem2otqa4Hxj3lim135ilOsaXhlCLWjD2k/S4D1lp6Or+SWuQWYikEYmloeW1KJl5BXrWKVIsrDj5tln3t7z5wx/f6naPPXgBgGj/uiHnSJYSbY80iQR1uYM+qaLi; AWSALB=6BFotXdiV8zWoArRMYFzFQvwdXc4mbFcUA8rZwr6Uhoxdv/2xo6h+5CF/6pEH5JYOFc1b1K8ckl+IcLXrCiUBvo+SUT1oYUnz7qrYcBJOhnF1+GJpV5limbktARrMgFfMiUIdQsbOHdaQHkQr/yIhiIDNYxLqIAgMqkVIbLd+n2tioi/B0iTc5YunHMnNloNMICDRgp4sxRfon5lmObtCQa15SU4qrTrqCsdseesAhgHQMPRSrhMEj4sLL9zFPgF1SM/psq8/WMRL5P2spnnUZP/QXD3PpW+3c0Q3xqX6IE6tUNxIVCSfS9HaBgipPid; AWSALBCORS=6BFotXdiV8zWoArRMYFzFQvwdXc4mbFcUA8rZwr6Uhoxdv/2xo6h+5CF/6pEH5JYOFc1b1K8ckl+IcLXrCiUBvo+SUT1oYUnz7qrYcBJOhnF1+GJpV5limbktARrMgFfMiUIdQsbOHdaQHkQr/yIhiIDNYxLqIAgMqkVIbLd+n2tioi/B0iTc5YunHMnNloNMICDRgp4sxRfon5lmObtCQa15SU4qrTrqCsdseesAhgHQMPRSrhMEj4sLL9zFPgF1SM/psq8/WMRL5P2spnnUZP/QXD3PpW+3c0Q3xqX6IE6tUNxIVCSfS9HaBgipPid' \
//   --compressed \
//   -o transcript.json