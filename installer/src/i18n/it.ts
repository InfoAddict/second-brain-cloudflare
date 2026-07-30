import type { Messages } from "./types";

export const it: Messages = {
  common: {
    continue: "Continua",
    back: "Indietro",
    copy: "Copia",
    copied: "Copiato ✓",
    copyBoth: "Copia entrambi",
    copyLink: "Copia link",
    copyAddress: "Copia indirizzo",
    copyCommand: "Copia comando",
    connect: "Collega",
    connecting: "Collegamento…",
    connected: "Collegato ✓",
    openSettings: "Apri impostazioni",
    emailDetails: "Invia per email",
    notNow: "Non ora",
    tryAgain: "Riprova",
    checking: "Verifica…",
    ready: "Pronto",
    notFound: "Non trovato",
    demoMode: "Modalità demo",
    appTitle: "Second Brain",
  },
  settings: {
    title: "Impostazioni",
    language: "Lingua",
    languageDesc: "Scegli come visualizzare l'app Second Brain su questo computer.",
    english: "English",
    italian: "Italiano",
  },
  settingsPanel: {
    title: "Impostazioni avanzate",
    lede: "Come il tuo Second Brain ricorda e recupera. Le modifiche valgono dalla prossima ricerca.",
    sectionRecall: "Recupero",
    sectionRemember: "Ricorda",
    sectionAi: "AI",
    sectionMatching: "Corrispondenze",
    custom: "Personalizzato",
    customNote: "Questi valori sono stati impostati fuori dall'app e non corrispondono a nessun livello. Scegliendo un livello qui sotto verranno sostituiti.",
    reset: "Ripristina il valore predefinito",
    save: "Salva le modifiche",
    cancel: "Annulla",
    unsaved: "{count} modifiche non salvate",
    unsavedOne: "1 modifica non salvata",
    saving: "Salvataggio…",
    saved: "Salvato",
    loadFailed: "Non è stato possibile caricare le impostazioni.",
    recency: {
      label: "Quanto i ricordi recenti contano più di quelli vecchi",
      desc: "I ricordi più vecchi perdono gradualmente terreno rispetto ai nuovi. Qui decidi con quanta rapidità — e quanta protezione ottengono i ricordi consolidati e importanti.",
      levels: {
        timeless: {
          name: "Senza tempo",
          notice: "L'età conta appena. Utile se il tuo Second Brain è soprattutto materiale di riferimento che vuoi ritrovare a prescindere da quando l'hai salvato.",
        },
        balanced: {
          name: "Bilanciato",
          notice: "Il valore predefinito. A parità vince il più recente, ma una buona corrispondenza vecchia batte comunque una debole recente.",
        },
        recent_first: {
          name: "Priorità ai recenti",
          notice: "I ricordi nuovi dominano. Utile per lavoro che cambia in fretta, al prezzo di seppellire il contesto più vecchio.",
        },
      },
    },
    variety: {
      label: "Varietà nei risultati",
      desc: "Quando più ricordi dicono quasi la stessa cosa, Second Brain può restituirli tutti oppure distribuire i risultati.",
      levels: {
        focused: { name: "Mirato", notice: "Le corrispondenze più vicine, anche se alcune si ripetono." },
        balanced: { name: "Bilanciato", notice: "Il valore predefinito." },
        varied: {
          name: "Vario",
          notice: "Una scelta più ampia di ricordi diversi. Alcune corrispondenze molto simili vengono escluse per fare spazio.",
        },
      },
    },
    connections: {
      label: "Quanto seguire i collegamenti",
      desc: "Oltre alle corrispondenze dirette, Second Brain può percorrere i collegamenti tra i ricordi e portare anche ciò a cui sono connessi.",
      levels: {
        off: { name: "Disattivato", notice: "Solo corrispondenze dirette." },
        nearby: { name: "Vicini", notice: "Un passo più in là. Fa emergere contesto ovvio che non avevi cercato." },
        extended: {
          name: "Estesi",
          notice: "Due passi più in là. Contesto più ricco e, di tanto in tanto, qualcosa di forzato.",
        },
      },
    },
    detail: {
      label: "Quanto dettaglio viene restituito",
      desc: "Definisce quanta parte di ogni ricordo viene inviata al tuo assistente.",
      levels: {
        compact: {
          name: "Compatto",
          notice: "Estratti brevi. Lascia più spazio nella finestra di contesto del tuo assistente.",
        },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. Testo completo per le prime corrispondenze, estratti per le altre.",
        },
        full: {
          name: "Completo",
          notice: "Più contenuto per ogni ricordo. Risposte migliori, con un consumo di contesto molto più alto.",
        },
      },
    },
    duplicates: {
      label: "Blocco dei salvataggi quasi duplicati",
      desc: "Quando qualcosa di molto simile è già salvato, Second Brain può bloccare il salvataggio o lasciarlo passare segnalandolo.",
      note: "Vale per i nuovi salvataggi. I duplicati già presenti nel tuo Second Brain non vengono toccati.",
      levels: {
        permissive: { name: "Permissivo", notice: "Si salva quasi tutto. Le ripetizioni si accumulano." },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. I salvataggi quasi identici vengono bloccati, quelli simili segnalati.",
        },
        strict: {
          name: "Rigoroso",
          notice: "Blocca in modo aggressivo. A volte rifiuta un aggiornamento legittimo a qualcosa che avevi già salvato.",
        },
      },
    },
    compression: {
      label: "Compressione dei ricordi vecchi",
      desc: "Ogni notte, i ricordi vecchi che recuperi raramente possono essere riassunti perché la ricerca resti efficace.",
      note: "Ha effetto dall'esecuzione di questa notte. I ricordi già compressi restano compressi.",
      levels: {
        conservative: {
          name: "Conservativo",
          notice: "Protegge di più. Il tuo Second Brain cresce e le ricerche diventano via via più lente.",
        },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. I ricordi importanti o recuperati spesso non vengono mai compressi.",
        },
        aggressive: {
          name: "Aggressivo",
          notice: "Comprime prima. Cervello più snello, ma i dettagli dei ricordi vecchi vengono riassunti via.",
        },
      },
    },
    model: {
      label: "Quale modello AI usare",
      desc: "Usato per ordinare, riassumere e individuare contraddizioni nei tuoi ricordi — non per la ricerca in sé. Ogni modello elencato qui gira sul tuo account Cloudflare.",
      sizeNote: "I modelli più grandi scrivono riassunti migliori e costano più Neurons. Quelli più piccoli sono più rapidi ed economici.",
      neuronsNote: "I Neurons sono l'unità di consumo AI di Cloudflare. Il tuo piano include un'assegnazione giornaliera.",
    },
    migration: {
      lede: "Come il tuo Second Brain legge i tuoi ricordi e li abbina a ciò che chiedi.",
      label: "Come vengono letti i tuoi ricordi",
      desc:
        "Ogni ricordo viene letto una volta quando lo salvi, e le ricerche vengono " +
        "confrontate con quella lettura. Una lettura diversa può trovare corrispondenze " +
        "più precise, ma prima tutto ciò che hai già salvato va riletto.",
      entries: "{entries} ricordi salvati, in almeno {chunks} parti da rileggere.",
      pickLabel: "Leggi i miei ricordi con",
      inUse: "{name} (in uso ora)",
      pickNote:
        "Le opzioni più in basso nell'elenco leggono i tuoi ricordi con più finezza e " +
        "consumano una parte maggiore della tua assegnazione AI giornaliera. Girano tutte " +
        "sul tuo account Cloudflare.",
      sameAsCurrent: "È già quella in uso — non c'è nulla da fare.",
      dirtyNote: "Salva o annulla prima le altre modifiche.",
      startButton: "Ricostruisci con questa",
      confirmTitle: "Prima di iniziare",
      confirmBody:
        "I tuoi ricordi sono al sicuro. Il testo di ciò che hai salvato non viene mai " +
        "toccato: viene ricostruito solo ciò che il tuo Second Brain usa per cercare.",
      point1:
        "Durante la ricostruzione la ricerca è incompleta. I ricordi non ancora riletti " +
        "non compaiono tra i risultati.",
      point2:
        "Può richiedere tempo: ci sono {chunks} parti da rileggere e si consuma la tua " +
        "assegnazione AI giornaliera. Se l'assegnazione finisce, il lavoro si mette in " +
        "pausa e riprende da dove era arrivato.",
      point3:
        "Lungo il percorso non viene cancellato nulla. I vecchi dati di ricerca restano " +
        "finché non scegli tu di liberarli alla fine, e quell'ultimo passaggio è il solo " +
        "che non si può annullare.",
      targetLine: "Si passa a: {name}",
      confirmButton: "Sì, ricostruisci",
      cancelButton: "Non ora",
      startingTitle: "Preparazione",
      startingBody:
        "Prepariamo il nuovo modo di leggere i tuoi ricordi, poi il tuo Second Brain " +
        "inizia a usarlo. Ci vuole un minuto o due — lascia aperta questa finestra.",
      runningTitle: "Rilettura dei tuoi ricordi",
      runningBody:
        "Finché non finisce, la ricerca è incompleta: ciò che non è ancora stato riletto " +
        "non compare tra i risultati. Lascia aperta questa finestra; chiudendola la " +
        "ricostruzione si mette in pausa e nulla di già fatto va perso.",
      progress: "{done} di {total} completati",
      progressPending: "Elaborazione in corso…",
      skipped:
        "Non è stato possibile rileggere: {failed}. Ciò che manca potrebbe non comparire " +
        "nelle ricerche.",
      stalledTitle: "In pausa per oggi",
      stalledBody:
        "L'assegnazione AI di oggi è esaurita. Tutto ciò che è stato fatto è salvato e " +
        "riprendere non costa nulla per la parte già completata. Torna domani, o quando la " +
        "tua assegnazione si rinnova.",
      resumeButton: "Continua",
      interruptedTitle: "Una ricostruzione è rimasta a metà",
      interruptedBody:
        "Una ricostruzione si è fermata a metà: {done} di {total} completati. La ricerca " +
        "resta incompleta finché non finisce, e continuare non costa nulla per la parte " +
        "già completata.",
      failedTitle: "La ricostruzione si è fermata",
      failedBody:
        "I tuoi ricordi non sono stati toccati e tutto ciò che è stato fatto è salvato. " +
        "Continuando, nulla verrà ripetuto.",
      stuck:
        "La ricostruzione ha smesso di avanzare, così l'abbiamo interrotta. Niente è " +
        "andato perso — riprova tra qualche minuto.",
      doneTitle: "I tuoi ricordi sono stati riletti tutti",
      doneBody:
        "La ricerca è di nuovo completa e il tuo Second Brain abbina i ricordi nel modo nuovo.",
      freeLabel: "Libera i vecchi dati di ricerca",
      freeDesc:
        "I dati di ricerca precedenti alla ricostruzione sono ancora conservati e il tuo " +
        "Second Brain potrebbe ancora tornare a usarli. Liberarli recupera lo spazio che " +
        "occupano ed è il solo passaggio qui che non si può annullare.",
      freeButton: "Libera i vecchi dati",
      freeConfirm: "Sì, liberali — so che non si può annullare",
      freeKeep: "Conservali per ora",
      freeing: "Liberazione dei vecchi dati di ricerca",
      freeingBody: "Ci vuole solo un momento.",
      freedTitle: "Tutto fatto",
      freedBody:
        "Il tuo Second Brain legge e abbina i tuoi ricordi nel modo nuovo, e i vecchi dati " +
        "di ricerca non ci sono più. Nient'altro è cambiato.",
      freeUnknown:
        "Sono ancora conservati alcuni dati di ricerca precedenti alla ricostruzione. Non " +
        "influiscono su nulla e potranno essere liberati più avanti.",
      loading: "Verifica di come vengono letti i tuoi ricordi…",
      loadFailed: "Non è stato possibile verificare come vengono letti i tuoi ricordi.",
      barRunning:
        "Rilettura dei tuoi ricordi — {done} di {total} completati. Le altre impostazioni " +
        "sono bloccate fino alla fine.",
      barWorking:
        "Operazione in corso sul tuo Second Brain. Le altre impostazioni sono bloccate " +
        "fino alla fine.",
    },
  },
  welcome: {
    title: "Configura il tuo Second Brain",
    lede:
      "Una memoria privata condivisa tra tutti gli strumenti AI che usi. " +
      "Ogni app e dispositivo che colleghi è una porta sulla stessa memoria, " +
      "quindi non c'è nulla da sincronizzare tra loro. " +
      "Ci vogliono circa due minuti, tutto nel tuo spazio privato, " +
      "senza competenze tecniche.",
    getStarted: "Inizia",
    alreadyHave: "Hai già un Second Brain?",
    footnote: "Gratuito · I tuoi dati restano tuoi",
  },
  connectExisting: {
    title: "Collega il tuo Second Brain",
    lede:
      "Nuovo computer? Inserisci l'indirizzo e la password del Second Brain " +
      "che hai già — nulla verrà modificato o resettato.",
    addressPlaceholder: "Indirizzo Second Brain (…workers.dev)",
    passwordPlaceholder: "La tua password",
    connect: "Collega",
    footnote:
      "L'indirizzo è in Dettagli connessione sull'altro computer " +
      "o nell'email di conferma che hai inviato a te stesso.",
    chooseLede:
      "Nuovo computer? Collega il Second Brain che hai già — nulla verrà " +
      "modificato o resettato.",
    signInButton: "Accedi con Cloudflare",
    signInHint: "Troveremo noi il tuo Second Brain — nessun indirizzo da cercare.",
    signInFootnote:
      "Il tuo Second Brain si trova nel tuo spazio su Cloudflare, quindi " +
      "accediamo lì per trovarlo. Cloudflare ti chiederà di autorizzare " +
      "l'accesso. Non vediamo mai la tua password Cloudflare e non conserviamo " +
      "la chiave: accedi di nuovo ogni volta. Preferisci di no? " +
      "\u201cInserisci l'indirizzo a mano\u201d non richiede l'accesso a Cloudflare.",
    manualButton: "Inserisci l'indirizzo a mano",
    accountPickerTitle: "In quale spazio cerchiamo?",
    accountPickerLede: "Il tuo login ne ha più di uno — scegli dove si trova il tuo Second Brain.",
    searchingTitle: "Ricerca del tuo Second Brain",
    searchingLede: "Controlliamo il tuo spazio Cloudflare. Può richiedere fino a un minuto.",
    searchingStep: "Analisi del tuo spazio",
    pickTitleOne: "È questo il tuo Second Brain?",
    pickTitleMany: "Quale è il tuo Second Brain?",
    pickLedeOne: "Collegati, oppure inserisci a mano un altro indirizzo.",
    pickLedeMany: "Scegli quello a cui vuoi collegarti.",
    noneFound:
      "Non abbiamo trovato un Second Brain in quello spazio. Se si trova " +
      "altrove — un altro spazio o un tuo indirizzo web — inserisci l'indirizzo qui sotto.",
    unlockTitle: "Inserisci la tua password",
    unlockLede:
      "È la password che hai scelto quando hai configurato il tuo Second Brain " +
      "la prima volta. Nulla verrà modificato o resettato.",
  },
  password: {
    title: "Crea la tua password",
    lede:
      "È la chiave del tuo Second Brain. La userai per collegare nuovi strumenti " +
      "e per accedere da altri computer.",
    placeholder: "Scegli una password (12+ caratteri)",
    confirmPlaceholder: "Ripeti la password",
    generateTitle: "Genera una password sicura per me",
    tooShort: "Troppo corta",
    checking: "Verifica…",
    foundInBreaches: "Trovata in violazioni",
    strong: "Robusta",
    good: "Buona",
    easyToGuess: "Facile da indovinare",
    breachHint:
      "Questa password è comparsa in violazioni di dati ed è insicura. " +
      "Prova un'altra o genera una nuova.",
    mismatch: "Le password non coincidono.",
    notice:
      "Salvala in un posto sicuro — un gestore password è ideale. " +
      "Ti servirà per collegare nuovi strumenti; non può essere recuperata.",
    footnote:
      "Verifichiamo le password contro violazioni note senza inviare la password: " +
      "solo un frammento di impronta lascia questo computer.",
  },
  cloudflare: {
    title: "Collega il tuo account",
    lede:
      "Il Second Brain vive nel tuo spazio privato su Cloudflare — " +
      "le tue memorie sono tue, non nostre. Accedi o crea un account gratuito.",
    signIn: "Accedi per creare il tuo spazio",
    footnote: "Non vediamo la password Cloudflare.",
    waitingTitle: "In attesa del browser…",
    waitingLede:
      "Completa l'accesso (o la creazione dell'account) nel browser aperto, " +
      "poi torna qui.",
    watchingSignIn: "In attesa che completi l'accesso",
    pickerTitle: "In quale spazio installarlo?",
    pickerLede: "Il tuo login ha più di uno — scegli dove mettere il Second Brain.",
  },
  progress: {
    title: "Configurazione del Second Brain",
    lede: "Di solito ci vuole un minuto o due. Puoi allungarti.",
    stepSpace: "Creazione dello spazio privato",
    stepMemory: "Creazione del deposito memorie",
    stepRecall: "Attivazione del richiamo intelligente",
    stepFinish: "Completamento",
  },
  tools: {
    title: "Collega i tuoi strumenti AI",
    lede: "Dai a ogni strumento accesso alla stessa memoria. Puoi aggiungere altri più tardi.",
    autoSetup: "Configurazione automatica.",
    notOnComputer: "Non trovato su questo computer.",
    doneRestart: "Fatto — riavvia lo strumento per usare il Second Brain.",
    cliSub: "Usa il Second Brain da terminale.",
    setupCli: "Configura CLI",
    settingUp: "Configurazione…",
    cliDone: "Fatto. Il comando brain è pronto nel terminale.",
    installing: "Installazione…",
    installed: "Installato ✓",
    reopenTerminal: "Il comando brain è pronto. Riapri il terminale se non lo trovi.",
    configSaved: "Config salvata ✓",
    configSavedInstallFailed: "Config salvata, ma l'installazione non è finita. Esegui: ",
    configSavedNoNpm: "Config salvata. Installa Node.js, poi esegui: ",
    pasteInSettings: "Copia il link e incollalo nei connettori nelle impostazioni.",
    claudeCode: "Claude Code",
    cursor: "Cursor",
    cliTitle: "Second Brain CLI",
    chatgpt: "ChatGPT",
    claudeWeb: "Claude (web e desktop)",
  },
  details: {
    title: "Connessioni",
    lede:
      "Da qui colleghi le cose al tuo Second Brain. " +
      "Le memorie vivono nella dashboard, che si apre in una finestra dedicata.",
    notSetupTitle: "Non ancora configurato",
    notSetupLede: "Completa prima la configurazione — i dettagli appariranno qui.",
    addressLabel: "Indirizzo del Second Brain",
    addressDesc: "La dashboard web privata e dove collegi nuovi strumenti. Salvalo.",
    mcpLabel: "Link di connessione (per strumenti AI)",
    mcpDesc: "Incollalo in qualsiasi strumento AI che supporta i connettori.",
    connectToolsTitle: "Collega i tuoi strumenti AI",
    connectToolsDesc:
      "Gli strumenti su questo computer si collegano con un clic. Per gli altri, " +
      "incolla il link di connessione nelle impostazioni del connettore — " +
      "chiederà la password la prima volta.",
    integrationsTitle: "Integrazioni",
    integrationsDesc: "Importa note e pagine dagli strumenti che già usi.",
    navConnection: "Connessione",
    navTools: "Strumenti AI",
    navIntegrations: "Integrazioni",
    navComputer: "Questo computer",
    updateLabel: "È disponibile un nuovo Second Brain ({version})",
    updateDesc:
      "Aggiorna per le ultime novità. Memorie, password e strumenti collegati restano.",
    updateButton: "Aggiorna il Second Brain",
    allSetTitle: "Tutto pronto",
    allSetLede: "Due link da conservare. Li trovi sempre qui in Dettagli connessione.",
    openDashboard: "Apri il mio Second Brain",
  },
  integrations: {
    extensionTitle: "Estensione browser",
    extensionSub: "Salva pagine e evidenziazioni. Inserisci indirizzo e password nella configurazione.",
    getExtension: "Ottieni l'estensione",
    obsidianTitle: "Sincronizzazione Obsidian",
    obsidianSub: "Allinea il vault Obsidian con il Second Brain.",
    openObsidian: "Apri in Obsidian",
    getPlugin: "Ottieni il plugin",
    connectedPlain: "Collegato.",
    connectedTo: "Collegato a {workspace}.",
    syncNow: "Sincronizza ora",
    syncing: "Sincronizzazione…",
    manage: "Gestisci",
    setUp: "Configura",
    appsTitle: "App",
    back: "Tutte le integrazioni",
    categoryKnowledge: "Conoscenza",
    categoryCalendar: "Calendari",
    categoryEmail: "Email",
    categoryOther: "Altro",
  },
  logout: {
    button: "Esci da questo computer",
    confirm: "Sì, esci",
    keep: "Resta connesso",
    desc:
      "Il Second Brain e tutte le memorie restano al sicuro — questo rimuove solo " +
      "la connessione su questo computer. Puoi ricollegarti con indirizzo e password.",
  },
  workerUpdate: {
    title: "Aggiorna il Second Brain",
    ledeWithVersion:
      "È disponibile una nuova versione ({version}). " +
      "Memorie, password e strumenti collegati restano — nulla viene resettato.",
    ledeGeneric:
      "È disponibile una nuova versione del Second Brain. " +
      "Memorie, password e strumenti collegati restano — nulla viene resettato.",
    notice: "Accederai a Cloudflare una volta per autorizzare l'aggiornamento. Circa un minuto.",
    signInUpdate: "Accedi e aggiorna",
    waitingLede:
      "Completa l'accesso a Cloudflare nel browser aperto, poi torna qui.",
    updatingTitle: "Aggiornamento del Second Brain",
    updatingLede: "Di solito ci vuole un minuto. Le tue memorie sono al sicuro.",
    stepMemory: "Aggiornamento deposito memorie",
    stepRecall: "Aggiornamento richiamo intelligente",
    stepFinish: "Completamento",
    doneTitle: "Second Brain aggiornato",
    doneLede:
      "Tutto è all'ultima versione — memorie, password e strumenti collegati non sono cambiati.",
  },
  email: {
    subject: "Dettagli del tuo Second Brain",
    bodyAddress: "Indirizzo Second Brain (dashboard privata):",
    bodyMcp: "Link di connessione (incolla negli strumenti AI con connettori):",
  },
};
