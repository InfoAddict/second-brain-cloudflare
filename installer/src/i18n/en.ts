import type { Messages } from "./types";

export const en: Messages = {
  common: {
    continue: "Continue",
    back: "Back",
    copy: "Copy",
    copied: "Copied ✓",
    copyBoth: "Copy both",
    copyLink: "Copy link",
    copyAddress: "Copy address",
    copyCommand: "Copy command",
    connect: "Connect",
    connecting: "Connecting…",
    connected: "Connected ✓",
    openSettings: "Open settings",
    emailDetails: "Email these to myself",
    notNow: "Not now",
    tryAgain: "Try again",
    checking: "Checking…",
    ready: "Ready",
    notFound: "Not found",
    demoMode: "Demo mode",
    appTitle: "Second Brain",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageDesc: "Choose how the Second Brain app is displayed on this computer.",
    english: "English",
    italian: "Italiano",
  },
  settingsPanel: {
    title: "Advanced Settings",
    lede: "How your Second Brain remembers and recalls. Changes apply to your next search.",
    sectionRecall: "Recall",
    sectionRemember: "Remember",
    sectionAi: "AI",
    sectionMatching: "Matching",
    custom: "Custom",
    customNote: "These values were set outside the app and don't match a preset. Picking a level below will replace them.",
    reset: "Reset to default",
    save: "Save changes",
    cancel: "Cancel",
    unsaved: "{count} unsaved changes",
    unsavedOne: "1 unsaved change",
    saving: "Saving…",
    saved: "Saved",
    loadFailed: "Couldn't load your settings.",
    recency: {
      label: "How much recent memories outrank older ones",
      desc: "Older memories gradually lose ground to newer ones. This sets how steeply — and how much protection settled, important memories get.",
      levels: {
        timeless: {
          name: "Timeless",
          notice: "Age barely matters. Good if your brain is mostly reference you want found regardless of when you saved it.",
        },
        balanced: {
          name: "Balanced",
          notice: "The default. Recent wins ties, but a strong old match still beats a weak new one.",
        },
        recent_first: {
          name: "Recent-first",
          notice: "Newer memories dominate. Good for fast-moving work, at the cost of burying older context.",
        },
      },
    },
    variety: {
      label: "Variety in results",
      desc: "When several memories say nearly the same thing, Second Brain can return all of them or spread the results out.",
      levels: {
        focused: { name: "Focused", notice: "The closest matches, even if a few repeat each other." },
        balanced: { name: "Balanced", notice: "The default." },
        varied: {
          name: "Varied",
          notice: "A wider spread of different memories. Some very close matches get dropped to make room.",
        },
      },
    },
    connections: {
      label: "How far to follow connections",
      desc: "Past direct matches, Second Brain can walk the links between memories and pull in what they connect to.",
      levels: {
        off: { name: "Off", notice: "Direct matches only." },
        nearby: { name: "Nearby", notice: "One step out. Surfaces obvious context you didn't search for." },
        extended: {
          name: "Extended",
          notice: "Two steps out. Richer context, and occasionally something you'd call a stretch.",
        },
      },
    },
    detail: {
      label: "How much detail comes back",
      desc: "Sets how much of each memory gets sent to your assistant.",
      levels: {
        compact: {
          name: "Compact",
          notice: "Short snippets. Leaves the most room in your assistant's context window.",
        },
        standard: { name: "Standard", notice: "The default. Full text for the top matches, snippets below." },
        full: { name: "Full", notice: "More of every memory. Best answers, uses noticeably more context." },
      },
    },
    duplicates: {
      label: "Blocking near-duplicate saves",
      desc: "When something very similar is already stored, Second Brain can block the save or let it through with a flag.",
      note: "Applies to new saves. Duplicates already in your brain aren't affected.",
      levels: {
        permissive: { name: "Permissive", notice: "Almost everything saves. Repeats accumulate." },
        standard: {
          name: "Standard",
          notice: "The default. Near-identical saves are blocked, similar ones flagged.",
        },
        strict: {
          name: "Strict",
          notice: "Blocks aggressively. Occasionally rejects a genuine update to something you already stored.",
        },
      },
    },
    compression: {
      label: "Compressing old memories",
      desc: "Each night, old memories you rarely recall can be folded into summaries so search stays sharp.",
      note: "Takes effect on tonight's run. Already-compressed memories stay compressed.",
      levels: {
        conservative: {
          name: "Conservative",
          notice: "Protects more. Your brain grows larger and searches get gradually slower.",
        },
        standard: {
          name: "Standard",
          notice: "The default. Important or frequently-recalled memories are never compressed.",
        },
        aggressive: {
          name: "Aggressive",
          notice: "Compresses sooner. Leaner brain, and detail in old memories is summarized away.",
        },
      },
    },
    model: {
      label: "Which AI model to use",
      desc: "Used for sorting, summarizing, and spotting contradictions in your memories — not for the search itself. Every model here runs on your own Cloudflare account.",
      sizeNote: "Larger models write better summaries and cost more neurons. Smaller ones are faster and cheaper.",
      neuronsNote: "Neurons are Cloudflare's usage unit for AI. Your plan includes a daily allowance.",
    },
    migration: {
      lede: "How your Second Brain reads your memories and matches them to what you ask for.",
      label: "How your memories are read",
      desc:
        "Each memory is read once when you save it, and searches are matched against that " +
        "reading. A different reader can match more precisely, but everything you have " +
        "already saved has to be read again first.",
      // Counted in memories, the same unit the progress line uses. The piece
      // count appears only where it is about the daily AI allowance, so the two
      // screens never present the same job in two different units.
      entries: "{entries} memories saved, all to be read again.",
      entriesOne: "1 memory saved, to be read again.",
      entriesNone: "No memories saved yet, so there is nothing to read again.",
      pickLabel: "How to read your memories",
      inUse: "{name} (in use now)",
      storageWarning:
        "This is more than a free Cloudflare account can hold for a brain your " +
        "size. While the rebuild runs, both the old and new search data are kept " +
        "so you can still change your mind — and that is when it would run out. " +
        "Saving new memories would start failing. A coarser option, or a paid " +
        "Cloudflare plan, avoids it.",
      pickNote:
        "Reading in more detail matches more precisely and uses more of your daily AI " +
        "allowance. All of these run on your own Cloudflare account.",
      /**
       * The picker shows these names and never the model id. This is the last
       * label read before a one-way operation, and the position of an opaque
       * string in a list is not something anyone can reason about well.
       */
      levels: {
        standard: {
          name: "Standard",
          notice:
            "Lightest on your daily AI allowance and the quickest to rebuild. Good enough " +
            "for most searches.",
        },
        finer: {
          name: "Finer detail",
          notice:
            "Catches more of what each memory is about, so near-misses sort better. Uses " +
            "more of your daily AI allowance.",
        },
        finest: {
          name: "Finest detail",
          notice:
            "The most precise matching, and the heaviest on both your daily AI allowance " +
            "and your storage.",
        },
      },
      sameAsCurrent: "That's the one in use now — nothing to do.",
      dirtyNote: "Save or cancel your other changes first.",
      startButton: "Rebuild with this",
      confirmTitle: "Before you start",
      // One full-weight sentence. The rest of this screen is a grey block, and a
      // grey block before a one-way operation does not get read.
      confirmLead: "Search will be incomplete until this finishes.",
      confirmBody:
        "Your memories are safe — only what your Second Brain uses to search gets rebuilt.",
      point1: "Memories not read again yet won't come back in results.",
      point2: "It uses your daily AI allowance, and pauses for the day if that runs out.",
      // How long, in the only unit the app can honestly promise: batches are
      // capped by pieces, and the rounds run one after another.
      point3: "{chunks} pieces to read again — about {rounds} rounds, one after another.",
      point4: "Nothing is deleted until you choose to free the old search data at the end.",
      targetLine: "Switching to: {name}",
      // Secondary, and only here: the id earns its place on the screen that
      // commits, where someone may want to check exactly what they are getting.
      modelLine: "Model: {name}",
      confirmButton: "Yes, rebuild it",
      cancelButton: "Not now",
      startingTitle: "Getting ready",
      startingBody:
        "Setting up the new way of reading your memories, then pointing your Second Brain " +
        "at it. This takes a minute or two — leave this window open.",
      runningTitle: "Reading your memories again",
      runningBody:
        "Search is incomplete until this finishes. Leave this window open, or pause and " +
        "come back — nothing already read again is lost either way. The total can go up " +
        "if you save something new while this runs.",
      pauseButton: "Pause for now",
      pausing: "Pausing after this round…",
      pausedTitle: "Paused",
      pausedBody:
        "Everything read again so far is saved. Search stays incomplete until you carry " +
        "on, and carrying on costs nothing for what's already done.",
      progress: "{done} of {total} memories read again",
      progressPending: "Working through them now…",
      // Label form on purpose: it reads correctly at any count. Worded as
      // attempts because a memory that failed stays in front of the cursor and
      // is tried again, so this is a count of tries and not a count of losses.
      skipped:
        "Memories that couldn't be read again yet: {failed}. They get another try as this " +
        "carries on.",
      stalledTitle: "Paused for today",
      stalledBody:
        "Today's AI allowance is used up. Everything done so far is saved, and picking it " +
        "up again costs nothing for what's already done. Come back tomorrow, or whenever " +
        "your allowance resets.",
      // The other stall. "Come back tomorrow" is advice that can never work here,
      // and Carry on alone would rerun the identical failing round forever.
      stalledFailingTitle: "One memory is blocking the rebuild",
      stalledFailingBody:
        "The same memory keeps failing, so the last round got nothing done. Waiting won't " +
        "change that — the next try would run the identical round. Try again in case it " +
        "was a blip, or start over to forget where it got to and read everything from the " +
        "beginning.",
      resumeButton: "Carry on",
      startOverButton: "Start over instead",
      startOverNote:
        "Starting over reads every memory again, including the ones already done, and " +
        "spends your AI allowance on that work a second time.",
      resettingTitle: "Starting over",
      resettingBody:
        "Clearing the record of what has been read again, then beginning from your first " +
        "memory.",
      interruptedTitle: "A rebuild was left unfinished",
      interruptedBody:
        "A rebuild stopped partway — {done} of {total} done. Search stays incomplete until " +
        "it finishes, and carrying on costs nothing for what's already done.",
      failedTitle: "The rebuild stopped",
      failedBody:
        "Your memories are untouched and everything read again so far is saved. Carrying " +
        "on picks up where it stopped — it won't start over.",
      // Its own screen. Stacked under the failed copy this said the same thing
      // twice, in two voices, the second in red arguing with the first.
      stuckTitle: "The rebuild stopped making progress",
      stuck:
        "Nothing is lost, and everything read again so far is saved. Trying again in a few " +
        "minutes often clears it; if it doesn't, start over.",
      doneTitle: "Your memories have all been read again",
      doneBody:
        "Search is complete again, and your Second Brain is now matching memories the new way.",
      changeAgain: "Change this again",
      freeLabel: "Free up the old search data",
      freeDesc:
        "The search data from before the rebuild is still taking up space. Your memories " +
        "aren't touched — this only removes the leftover search data your Second Brain no " +
        "longer uses. It is the one step here that can't be undone.",
      freeButton: "Free up the old data",
      freeConfirm: "Yes, free it up — I know this can't be undone",
      freeKeep: "Keep it for now",
      freeing: "Freeing up the old search data",
      freeingBody: "This only takes a moment.",
      freedTitle: "All done",
      freedBody:
        "Your Second Brain reads and matches your memories the new way, and the old search " +
        "data is gone. Nothing else changed.",
      loading: "Checking how your memories are read…",
      loadFailed: "Couldn't check how your memories are being read right now.",
      barRunning:
        "Reading your memories again — {done} of {total} done. Other settings are locked " +
        "until it finishes.",
      barWorking: "Working on your Second Brain. Other settings are locked until this finishes.",
    },
  },
  welcome: {
    title: "Let's set up your Second Brain",
    lede:
      "One private memory that every AI tool you use can share. " +
      "Every app and device you connect is a door into the same memory, " +
      "so there is nothing to sync between them. " +
      "It takes about two minutes, lives in your own private space, " +
      "and nothing technical is required.",
    getStarted: "Get started",
    alreadyHave: "Already have a Second Brain?",
    footnote: "Free to run · Your data stays yours",
  },
  connectExisting: {
    title: "Connect your Second Brain",
    lede:
      "Setting up a new computer? Enter the address and password of the " +
      "Second Brain you already have — nothing will be changed or reset.",
    addressPlaceholder: "Your Second Brain address (…workers.dev)",
    passwordPlaceholder: "Your password",
    connect: "Connect",
    footnote:
      "The address is in Connection details on your other computer, " +
      "or in the confirmation email you sent yourself.",
    chooseLede:
      "Setting up a new computer? Connect the Second Brain you already have — " +
      "nothing will be changed or reset.",
    signInButton: "Sign in with Cloudflare",
    signInHint: "We'll find your Second Brain for you — no address to look up.",
    signInFootnote:
      "Your Second Brain lives in your own space at Cloudflare, so we sign in " +
      "there to find it. Cloudflare will ask you to allow access. We never see " +
      "your Cloudflare password, and we don't keep the key — you sign in again " +
      "each time. Prefer not to? \u201cEnter the address myself\u201d needs no " +
      "Cloudflare sign-in.",
    manualButton: "Enter the address myself",
    accountPickerTitle: "Which space should we look in?",
    accountPickerLede: "Your login has more than one — pick where your Second Brain lives.",
    searchingTitle: "Looking for your Second Brain",
    searchingLede: "Checking your Cloudflare space. This can take up to a minute.",
    searchingStep: "Looking through your space",
    pickTitleOne: "Is this your Second Brain?",
    pickTitleMany: "Which one is your Second Brain?",
    pickLedeOne: "Connect to it, or enter a different address yourself.",
    pickLedeMany: "Pick the one you want to connect to.",
    noneFound:
      "We couldn't find a Second Brain in that space. If it's somewhere " +
      "else — another space, or your own web address — enter the address below.",
    unlockTitle: "Enter your password",
    unlockLede:
      "This is the password you chose when you first set up your Second Brain. " +
      "Nothing will be changed or reset.",
  },
  password: {
    title: "Create your password",
    lede:
      "This is the key to your Second Brain. You'll use it to connect " +
      "new tools and to sign in from other computers.",
    placeholder: "Choose a password (12+ characters)",
    confirmPlaceholder: "Type it again",
    generateTitle: "Generate a strong password for me",
    tooShort: "Too short",
    checking: "Checking…",
    foundInBreaches: "Found in breaches",
    strong: "Strong",
    good: "Good",
    easyToGuess: "Easy to guess",
    breachHint:
      "This password has appeared in data breaches, so it isn't safe " +
      "to use here. Try another, or let us generate one.",
    mismatch: "Those don't match yet.",
    notice:
      "Save this somewhere safe — a password manager is perfect. " +
      "You'll need it to connect new tools later, and it can't be recovered for you.",
    footnote:
      "We check new passwords against known data breaches without ever " +
      "sending your password anywhere — only a fragment of a fingerprint " +
      "leaves this computer.",
  },
  cloudflare: {
    title: "Connect your account",
    lede:
      "Your Second Brain lives in your own private space, powered by " +
      "Cloudflare — so your memories belong to you, not to us. " +
      "Sign in, or create a free account in the same window.",
    signIn: "Sign in to create your space",
    footnote: "We never see your Cloudflare password.",
    waitingTitle: "Waiting for your browser…",
    waitingLede:
      "Finish signing in (or creating your free account) in the browser " +
      "window that just opened, then come back here.",
    watchingSignIn: "Watching for you to finish signing in",
    pickerTitle: "Which space should it live in?",
    pickerLede: "Your login has more than one — pick where your Second Brain goes.",
  },
  progress: {
    title: "Setting up your Second Brain",
    lede: "This usually takes a minute or two. Feel free to stretch.",
    stepSpace: "Creating your private space",
    stepMemory: "Building your memory store",
    stepRecall: "Turning on smart recall",
    stepFinish: "Finishing up",
  },
  tools: {
    title: "Connect your AI tools",
    lede: "Give each tool access to the same shared memory. You can always connect more later.",
    autoSetup: "Sets it up for you automatically.",
    notOnComputer: "Not found on this computer.",
    doneRestart: "Done — restart the tool to start using your Second Brain.",
    cliSub: "Use your Second Brain from the terminal.",
    setupCli: "Set up CLI",
    settingUp: "Setting up…",
    cliDone: "Done. The brain command is ready in your terminal.",
    installing: "Installing…",
    installed: "Installed ✓",
    reopenTerminal: "The brain command is ready. Reopen your terminal if it isn't found yet.",
    configSaved: "Config saved ✓",
    configSavedInstallFailed: "Config saved, but the install didn't finish. Run it yourself: ",
    configSavedNoNpm: "Config saved. Install Node.js, then run: ",
    pasteInSettings: "Copy the link, then paste it under connectors in settings.",
    claudeCode: "Claude Code",
    cursor: "Cursor",
    cliTitle: "Second Brain CLI",
    chatgpt: "ChatGPT",
    claudeWeb: "Claude (web & desktop)",
  },
  details: {
    title: "Connections",
    lede:
      "This window is where you connect things to your Second Brain. " +
      "Your memories themselves live in the dashboard, which opens in its own window.",
    notSetupTitle: "Not set up yet",
    notSetupLede: "Finish setting up your Second Brain first — these details appear here afterwards.",
    addressLabel: "Your Second Brain address",
    addressDesc: "Your private web dashboard, and where you connect new tools. Save it somewhere safe.",
    mcpLabel: "Your connection link (for AI tools)",
    mcpDesc: "Paste this into any AI tool that supports connectors.",
    connectToolsTitle: "Connect your AI tools",
    connectToolsDesc:
      "Tools on this computer connect with one click. For anything else, " +
      "paste your connection link into the tool's connector settings — " +
      "it will ask for your password the first time.",
    integrationsTitle: "Integrations",
    integrationsDesc: "Bring in notes and pages from the tools you already use.",
    navConnection: "Connection",
    navTools: "AI tools",
    navIntegrations: "Integrations",
    navComputer: "This computer",
    updateLabel: "A newer Second Brain is available ({version})",
    updateDesc:
      "Update to get the latest improvements. Your memories, password, and connected tools are kept.",
    updateButton: "Update my Second Brain",
    allSetTitle: "You're all set",
    allSetLede: "Two links to keep. You can always find them again in this app under Connection details.",
    openDashboard: "Open my Second Brain",
  },
  integrations: {
    extensionTitle: "Browser extension",
    extensionSub: "Capture any page or highlight. Paste your address and password into its setup.",
    getExtension: "Get the extension",
    obsidianTitle: "Obsidian sync",
    obsidianSub: "Keep your vault notes and your Second Brain in sync.",
    openObsidian: "Open in Obsidian",
    getPlugin: "Get the plugin",
    connectedPlain: "Connected.",
    connectedTo: "Connected to {workspace}.",
    syncNow: "Sync now",
    syncing: "Syncing…",
    manage: "Manage",
    setUp: "Set up",
    appsTitle: "Apps",
    back: "All integrations",
    categoryKnowledge: "Knowledge",
    categoryCalendar: "Calendars",
    categoryEmail: "Email",
    categoryOther: "Other",
  },
  logout: {
    button: "Log out of this computer",
    confirm: "Yes, log out",
    keep: "Keep me signed in",
    desc:
      "Your Second Brain and all its memories stay safe — this only forgets " +
      "the connection on this computer. You can reconnect anytime with " +
      "your address and password.",
  },
  workerUpdate: {
    title: "Update your Second Brain",
    ledeWithVersion:
      "A newer version of your Second Brain (version {version}) is ready to install. " +
      "Your memories, password, and connected tools are all kept — nothing is reset.",
    ledeGeneric:
      "A newer version of your Second Brain is ready to install. " +
      "Your memories, password, and connected tools are all kept — nothing is reset.",
    notice: "You'll sign in to Cloudflare once to authorize the update. It takes about a minute.",
    signInUpdate: "Sign in and update",
    waitingLede:
      "Finish signing in to Cloudflare in the browser window that just opened, then come back here.",
    updatingTitle: "Updating your Second Brain",
    updatingLede: "This usually takes a minute. Your memories are safe.",
    stepMemory: "Updating your memory store",
    stepRecall: "Refreshing smart recall",
    stepFinish: "Finishing up",
    doneTitle: "Your Second Brain is up to date",
    doneLede:
      "Everything's on the latest version — your memories, password, and connected tools are unchanged.",
  },
  email: {
    subject: "Your Second Brain details",
    bodyAddress: "Your Second Brain address (your private dashboard):",
    bodyMcp: "Your connection link (paste into AI tools that support connectors):",
  },
};
