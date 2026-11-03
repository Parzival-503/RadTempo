; ============================================================
;  RadTempo v2 - Radiology Productivity Tracker (AHK v1.1)
;
;  FEATURES:
;    - Timer: first F4 after F12 → next F12
;    - Modality selection: CR (X-ray), CT, MR, US, PET
;    - Study counter (daily, resets at midnight)
;    - CSV database with full analytics fields
;    - HTML dashboard generator (tray → Dashboard)
;    - Always-on-top compact widget, draggable
;
;  HOTKEYS (global):
;    Ctrl+Alt+F4 / F4 - start timer (first press only)
;    F12               - stop timer, log study
;
;  MODALITY BUTTONS:
;    Click on CR/CT/MR/US/PET in the widget to set modality
;    OR click the widget and press Tab to cycle through them.
;    Default: CT
; ============================================================

#Requires AutoHotkey v1.1.33+
#Persistent
#SingleInstance Force
#NoEnv
#UseHook On
#InstallKeybdHook
; A_TimeIdlePhysical only ignores artificial input for hooks that are actually
; installed. Without the MOUSE hook it reports keyboard-only idleness, so
; scrolling a stack - the commonest "actively reading" action - would look idle.
; Both hooks are required for the activity tracking below to mean anything.
#InstallMouseHook
SetBatchLines, -1

; --- State ---
global timerRunning   := false
global startTick      := 0
; A study still running after this many minutes was never signed with F12
; (signed another way, or left open overnight / over a weekend). The next F4
; drops it and starts fresh instead of being ignored. INI StaleStudyMin.
global STALE_STUDY_MIN := 240
global elapsed        := 0
global studyCount     := 0
global todayCount     := 0
global todayIVU       := 0.00
global todayIVU_CR    := 0.00
global todayIVU_CT    := 0.00
global todayIVU_MR    := 0.00
global todayIVU_US    := 0.00
global todayIVU_PET   := 0.00
global currentMod     := "CT"
global lastDate       := ""
global lastPACSWin    := 0  ; last detected PACS window HWND
global undoWindow     := false
global lastNumExams   := 1
global LOG_FILE       := A_ScriptDir . "\RadTempo_Log.csv"
global DASH_FILE      := A_ScriptDir . "\RadTempo_Dashboard.html"
global IVU_FILE       := A_ScriptDir . "\RadTempo_IVU.csv"
global lastExamText   := ""
global lastIVU        := 0.00
global pendingWrites  := ""

; --- Calibration against PowerScribe's own RVU ---
; PowerScribe bills off the ORDER's procedure code; RadTempo was
; guessing from the REPORT's prose. These hold the order fields for the
; study in progress. The accession is memory-only and never logged: it
; identifies a patient and its only job here is telling one order from
; the next.
global psProcCode     := ""      ; e.g. CTAABPEWWO - the billing key
global psProcDesc     := ""      ; order description, when not truncated
global psAccession    := ""      ; memory only, never written to disk
; PowerScribe's RVU Sum for the day is the authoritative total. Its grid is
; custom-painted and cannot be read by any means (see tools/ps_probe.ahk), so
; the number is typed in - and typing it CORRECTS today's tally rather than
; just reporting a gap. A discrepancy you can see but not fix is worthless:
; the tally is the reason the number exists. Goal rungs, credits and the
; reward bank all key off it.
global ADJ_FILE       := A_ScriptDir . "\\RadTempo_IVUAdjust.csv"
global adjByDate      := {}      ; "M/d/yyyy" -> IVU added to that day's logged total
global CAL_SCALE      := 1.0     ; IVU per PowerScribe RVU, if the units differ
global CAL_SHAKY_BELOW := 0.60   ; fuzzy score under which the widget marks a guess
global calLastPS      := 0.0     ; the last PowerScribe total typed in today
global calLastAt      := ""      ; when that was
global lastIVUSrc     := ""      ; learned | code | desc | none
global lastMatchScore := 0       ; fuzzy score behind a "desc" match

; --- Wellness: strain and breaks ---
; STRAIN is time at the desk, measured the way everything else in this app
; measures engagement - physical keyboard/mouse presence - not elapsed clock
; time and not sign events. The old model started a streak on the first F4 and
; only reset it after 30 minutes with no sign, so a stretch with a long quiet
; middle counted in full; and dismissing the box reset the streak whether or
; not a break was actually taken, which made the reminder self-defeating.
;
; Two states, one constant: you are on a break when you have been physically
; away for BREAK_MIN_MS, and accruing strain at every other moment. A break is
; the ONLY thing that clears strain - clicking the card does not.
global strainMs         := 0        ; at-the-desk ms since the last real break
global wellLastTick     := 0        ; A_TickCount at the previous strain sample
global wellNextMs       := 5400000  ; strain level at which the next nudge fires
global STREAK_LIMIT     := 5400000  ; strain before the first nudge (60 or 90 min)
global BREAK_MIN_MS     := 120000   ; continuous absence that counts as a break
global WELL_SNOOZE_MS   := 900000   ; extra strain before re-nudging with no break
global WELL_CARD_MS     := 45000    ; how long the card lingers before auto-hiding
global wellnessIndex    := 0        ; cycles through prompts
global lastBreakTime    := ""       ; clock time of the last verified break
global breaksToday      := 0        ; verified breaks since the date last rolled
global breaksDate       := ""       ; date breaksToday belongs to
global wellnessMinutes  := 90       ; user setting: 60 or 90
; --- Wellness card (the notification itself) ---
global wellCardOpen     := false
global wellCardAt       := 0        ; A_TickCount when the card was shown
global wellCardMode     := ""       ; "nudge" or "status"
global wellCardDone     := false    ; break verified while this card was up
global wellDoneAt       := 0        ; A_TickCount when that happened
global wellCardW        := 348
global wellCardH        := 182
global WellHwnd         := 0

; --- Forecast feature ---
global forecastGoal     := ""       ; user's daily IVU target (remembered)
global totalIVU         := 0.0      ; current forecast total (used by CalcGoal)

; --- Modalities ---
global MODS := ["CR", "CT", "MR", "US", "PET"]
global modIndex := 2  ; 1-based, default CT

; --- IVU Lookup Table ---
global ivuDescs := []   ; array of normalized descriptions
global ivuValues := []  ; parallel array of IVU floats
global ivuCodes := []   ; parallel array of exam codes (e.g. CTCHSCRWO)
LoadIVUTable()

; --- The filler exam ---
; When the assigned worklist runs dry, there is one exam type that gets read to
; top the day up. Everything the dashboard phrases as "how many more do I have
; to read" is denominated in it, because a raw IVU deficit is not a number you
; can act on and "3 more lung screenings" is.
; FILLER_MATCH is a case-insensitive RegEx matched against both the IVU table's
; normalized descriptions and the raw ExamText column of the log. It is also
; handed to the dashboard and compiled by JavaScript, so keep it to syntax both
; PCRE and JS accept - no AHK "i)" option prefix, no named-group extensions.
; Override in RadTempo.ini [Settings] FillerName / FillerMatch / FillerIVU.
global FILLER_NAME  := "lung screening"
global FILLER_MATCH := "LUNG.*(SCREEN|CANCER)|(SCREEN|LDCT).*LUNG"
global FILLER_IVU   := 0        ; INI override; 0 = derive from the IVU table

; --- Goal rungs ---
; Credit past the daily floor accrues in fixed steps, so a goal that lands
; between two rungs is worth the same as the rung below it. Goal presets snap
; onto a rung and the dashboard names the next one - that next rung is the
; whole answer to "I hit my number, why keep going".
; Override in RadTempo.ini [Settings] GoalBase / GoalStep.
; One step past the floor = one daily credit = one paid hour, so a total that
; lands between rungs is worth exactly the rung below it.
global GOAL_BASE  := 60
global GOAL_STEP  := 7
global GOAL_RUNGS := 8    ; how many presets the Daily Goal submenu lists

; --- Theme ---
; Shares the dashboard's validated palette so the widget and the analytics
; read as one product. Series/status hexes come from the same checked set.
global BG_MAIN        := "12122A"
global BG_RUN         := "141433"
global TXT_IDLE       := "6E6E92"
global TXT_RUN        := "FFFFFF"
global TXT_DONE       := "6FE0B0"
global TXT_LABEL      := "7A7A99"
global TXT_COUNT      := "B8B8CF"
global TXT_IVU        := "A9C8F5"
global SEG_BG         := "1C1C38"   ; segmented-control / action-button face
global tipMap         := {}         ; control hwnd -> hover tooltip text
global tipLastHwnd    := 0          ; last hovered control, to avoid re-showing
global ACT_DOT_ON     := "0CA30C"   ; status good - hands on the hardware
global ACT_DOT_OFF    := "D03B3B"   ; status critical - sustained no input
global ACCENT_IDLE    := "2B2B52"
global ACCENT_RUN     := "C98500"
global ACCENT_DONE    := "0CA30C"
global MOD_TXT        := "7A7A99"

; --- Speed warning (study taking too long) ---
global warnEnabled    := true     ; on by default, toggle via tray
global WARN_PCT       := 150       ; warn when elapsed exceeds this % of the study-type average
global examParMap     := {}        ; exam description -> par (MEDIAN engaged seconds)
global modParMap      := {}        ; modality -> par fallback
global parSec         := 0         ; par for the CURRENT study, 0 = not known yet
global parBase        := 0         ; suggested par before any wheel nudge
global parLocked      := false     ; true once par is based on a real exam type
global parAdjust      := 0         ; this study's wheel nudge, seconds
global parProvisional := false     ; par derived from elapsed history, not engaged
global parDlgOpen     := false     ; the Set-par dialog is showing

; Effective hourly rate, used to price TIME (idle gaps, engaged hours, time
; reclaimed) - never to price a study. Pricing per study would reward reading
; faster, which is exactly the incentive this app avoids. Override in
; RadTempo.ini [Settings] HourlyRate (0 = no dollar figures).
global HOURLY_RATE    := 0

; --- exam auto-detect schedule ---
; The old single shot at 10s was arbitrary: too late to be useful for par, and
; still too early whenever PowerScribe had not finished loading the study, in
; which case the read was simply lost until sign time. Now we look as soon as
; anything is there, backing off if it is not, then VERIFY once or twice more.
; The verify pass is what fixes the real failure: if PowerScribe was still
; showing the PREVIOUS study when we first looked, the text changes when the
; new one lands, and we correct. That works without any staleness heuristic -
; important, because two consecutive identical exams (two chest x-rays) are
; common and any "same text = stale" rule would false-positive on them.
global DET_FIND_GAPS  := "2,2,3,4,5,7,10,12"   ; seconds between search attempts
global DET_VER_GAPS   := "20,40"               ; verify passes, after first capture
; Set when the title was typed in by hand. PowerScribe is then not consulted
; again for this study - not by the verify passes and not at sign time - because
; a hand-typed title is only ever entered when PowerScribe has nothing right.
global examManual     := false
global detFindIdx     := 1
global detVerIdx      := 0
global detCaptured    := false
global detCapturedText := ""
global PAR_ENABLED    := true
global PAR_MIN_SAMPLES := 4        ; samples needed before a per-exam par
global PAR_STEP       := 15        ; wheel nudge, seconds
global parStreak      := 0         ; consecutive studies finished under par
global parBestStreak  := 0
global parWinsToday   := 0
global parRunToday    := 0
global parBestToday   := 0         ; longest under-par run TODAY (parBestStreak is all-time)

; --- The reward bank ---
; Two things get paid, and the mix is the point: focus scales what volume is
; worth, so neither alone pays much.
;
;   parPts   = wins + REWARD_STREAK_BONUS * floor(bestStreakToday / REWARD_STREAK_EVERY)
;   goalPts  = REWARD_RUNG_PTS * n(n+1)/2          n = goal rungs cleared
;   focusMul = 0.75 + 0.5 * winRate                (0.75 at 0%, 1.25 at 100%)
;   points   = parPts + goalPts * focusMul
;   dollars  = points * REWARD_PER_POINT           capped per calendar week
;
; A par win pays a FLAT amount, never one scaled by how far under you landed.
; Par is engaged time, so a flat token pays for not drifting; a margin-scaled
; one would put a price on reading faster inside a study, which is the single
; incentive this whole app exists to avoid. The upside lives in streaks -
; consistency - not in any one fast read. A loss costs nothing: a penalty would
; make a genuinely hard case feel expensive, which is how misses happen.
;
; Rung points are triangular, so each rung pays more than the last: 67 IVU pays
; 10, 74 pays 30, 81 pays 60, 88 pays 100.
global REWARD_ENABLED      := true
global REWARD_PER_POINT    := 0.20   ; dollars per point
global REWARD_RUNG_PTS     := 10     ; base points for the first rung
global REWARD_STREAK_EVERY := 5      ; consecutive wins per streak bonus
global REWARD_STREAK_BONUS := 3      ; points per completed streak block
global REWARD_WEEK_CAP     := 150    ; dollars, per calendar week
global REWARD_FILE         := A_ScriptDir . "\RadTempo_Rewards.csv"
global REWARD_STORE_URL    := "https://www.amazon.com/gift-cards"
global rewardCashed        := 0.0    ; lifetime total cashed out (from the ledger)
; Earnings count from this date forward, as yyyyMMdd. Without it the bank
; scores the whole back-catalogue the first time it runs and opens with a
; balance you never played for, which is not a reward - it is a rebate. Written
; on first run so the bank always starts the day the feature does.
global REWARD_START        := ""
global warnThreshold  := 0         ; computed threshold for the current study (0 = none)
global warnThreshLocked := false   ; true once threshold is based on a real exam type
global warnActive     := false     ; is the flashing warning currently showing
global warnFlashState := false     ; toggles the flash color
; Minimum samples before a per-type average is trusted
global WARN_MIN_SAMPLES := 4
; Absolute floor so brand-new/rare studies don't nag too early (seconds)
global WARN_FLOOR_SEC := 90
; Colors for the warning state
global WARN_BG_A      := "2A1420"  ; dark red
global WARN_BG_B      := "8A2438"  ; bright red
global WARN_TXT       := "FF9DB0"

; --- QGenda shift schedule integration ---
; Your personal QGenda iCal link is not stored in the code: it is read from
; RadTempo.ini [Settings] ShiftUrl (see LoadSettings()).
global SHIFT_ICAL_URL := ""
global SHIFT_CACHE    := A_ScriptDir . "\RadTempo_Shifts.csv"

; --- Daily IVU goal ---
; A goal you set for a DAY, kept per-date so consistency can be measured
; honestly: a goal only counts if it was committed to, and it is recorded
; whether or not the day went well. Stored separately from the study log so a
; day where you set a goal and read nothing is still visible.
global GOALS_FILE     := A_ScriptDir . "\RadTempo_Goals.csv"
global goalByDate     := {}        ; "M/d/yyyy" -> IVU target
global todayGoal      := 0
global shiftByDate    := {}        ; "M/d/yyyy" -> "Shift name"
global shiftCount     := 0         ; number of dates loaded
global shiftLastFetch := ""        ; yyyyMMddHHmmss of last successful fetch
global todayShift     := ""        ; active primary block (tray tip / logging)
global shiftStatAvgIVU := {}       ; shift -> avg IVU per worked day
global shiftStatDays   := {}       ; shift -> number of worked days
global overallDayAvgIVU := 0       ; all-blocks avg IVU per block
global overallDayCount  := 0

; --- Shift-event classification (INI-tunable) ---
global CLS_MOD_KEYS   := "POC,READOUT,CONF,CHART REVIEW"
global CLS_OFF_KEYS   := "OFF,VAC,ATO,SB/,FLOAT"
global CLS_NOISE_KEYS := "EXTRA HOURS,CUSTOM HOURS"
global CLS_ONSITE_RE  := ""
global WIN_AM_S := 8.0,  WIN_AM_E := 12.5   ; default AM block window
global WIN_PM_S := 12.5, WIN_PM_E := 17.0   ; default PM block window
global currentBlock  := ""         ; primary block active right now
global currentExtras := ""         ; modifiers overlapping right now
global shiftStatHrs  := {}         ; block -> avg scheduled hours (windowed only)
global shiftOnsite   := {}         ; block -> is on-site (OnsiteRegex)

; --- Persistent settings (survive restarts) ---
global INI_FILE       := A_ScriptDir . "\RadTempo.ini"
global lastSavedPosX  := ""        ; last widget position written to INI
global lastSavedPosY  := ""

; --- GUI dimensions ---
global GUI_W := 250
global GUI_H := 80

; --- Physical-activity tracking -----------------------------------------
;  Measures whether real hands are on the hardware during a study, so time
;  spent on a phone/laptop stops counting as "reading".
;
;  Threshold semantics (this is the whole design): a moment counts as ACTIVE
;  while A_TimeIdlePhysical is below ACT_IDLE_MS. Because that value only
;  crosses the threshold after a full stretch of no input, the first
;  ACT_IDLE_MS of every quiet stretch is inherently credited as active - which
;  is exactly the grace period dictation needs. Talking into PowerScribe for
;  two minutes costs at most one threshold's worth of "away"; being gone for
;  ten minutes still registers as ~nine. It errs toward crediting the user,
;  which is the correct direction: a false "idle" discredits the whole metric,
;  a false "active" costs a few seconds at the head of a real break.
global ACT_ENABLED    := true
global ACT_IDLE_MS    := 60000     ; sustained no-input before time counts as away
global studyActiveMs  := 0         ; accumulated active ms for the current study
global studyAwayMs    := 0         ; accumulated away ms for the current study
global actLastTick    := 0         ; A_TickCount at the previous sample
global actAwayRunMs   := 0         ; length of the away stretch in progress

; --- Init today's count from CSV ---
InitTodayCount()

; --- Load persisted settings (warn/wellness/goal/shift URL) ---
LoadSettings()

; --- Load cached shift schedule (network refresh happens 3s after start) ---
LoadShiftCache()

; --- Load per-study-type average times for the speed warning ---
LoadExamAverages()
LoadGoals()
LoadRewardLedger()

; --- Day totals corrected against PowerScribe ---
LoadAdjust()

; --- Per-shift historical stats (typical IVU per block) ---
LoadShiftStats()
UpdateCurrentBlock()

; --- Tray ---
Menu, Tray, Tip, RadTempo
Menu, Tray, NoStandard

; ============================================================
;  MENU
;  Grouped by how often things get used: everyday actions at
;  the top, the four tunable subsystems in the middle, and
;  maintenance / diagnostics tucked into submenus at the
;  bottom. Two levels deep, never three.
;  Shown from the tray icon AND by right-clicking the widget.
; ============================================================

; --- Submenu: correct the modality of the last logged study ---
Menu, FixLastMenu, Add, Change to CR,  FixLastCR
Menu, FixLastMenu, Add, Change to CT,  FixLastCT
Menu, FixLastMenu, Add, Change to MR,  FixLastMR
Menu, FixLastMenu, Add, Change to US,  FixLastUS
Menu, FixLastMenu, Add, Change to PET, FixLastPET

; --- Submenu: QGenda shifts ---
Menu, ShiftMenu, Add, Today's Shift,       MenuShiftToday
Menu, ShiftMenu, Add, View Schedule,       MenuShiftView
Menu, ShiftMenu, Add
Menu, ShiftMenu, Add, Refresh from QGenda, MenuShiftRefresh
Menu, ShiftMenu, Add, Backfill Log Shifts, MenuShiftBackfill

; --- Submenu: par + the overtime escalation built on top of it ---
Menu, SpeedMenu, Add, Turn On,  MenuSpeedOn
Menu, SpeedMenu, Add, Turn Off, MenuSpeedOff
Menu, SpeedMenu, Add
Menu, SpeedMenu, Add, Warn at 125`%, MenuSpeed125
Menu, SpeedMenu, Add, Warn at 150`%, MenuSpeed150
Menu, SpeedMenu, Add, Warn at 200`%, MenuSpeed200
Menu, SpeedMenu, Add
Menu, SpeedMenu, Add, Recompute Pars from History, MenuParRecompute
; (checkmarks are applied by ApplySettingsChecks() once settings load)

; --- Submenu: the reward bank ---
Menu, RewardMenu, Add, Today's Reward,   MenuRewardToday
Menu, RewardMenu, Add, The Bank...,      MenuRewardBank
Menu, RewardMenu, Add
Menu, RewardMenu, Add, Cash Out...,      MenuRewardCashOut
Menu, RewardMenu, Add
Menu, RewardMenu, Add, Set $ per Point..., MenuRewardRate
Menu, RewardMenu, Add, Start the Bank Today, MenuRewardRestart

; --- Submenu: the exam title for the study running right now ---
; PowerScribe sometimes has not registered the study by the time the adaptive
; search and its verify passes are finished, and after that nothing is watching.
; These two are the manual way back in.
Menu, ExamMenu, Add, Re-fetch from PowerScribe, MenuRefetchExam
Menu, ExamMenu, Add, Type the Title In..., MenuSetExamTitle

; --- Submenu: the daily IVU goal you bet against yourself ---
; The rungs ARE the goals worth setting. Credit accrues in whole steps of
; GOAL_STEP past GOAL_BASE - one step is one daily credit, which is one hour -
; so a goal that lands BETWEEN two rungs pays exactly what the rung below it
; pays. Listing them as presets means the goal you pick is always worth
; something, and it removes the arithmetic from the decision.
Menu, GoalMenu, Add, Set Today's Goal..., MenuGoalSet
Menu, GoalMenu, Add, Match a Typical Day, MenuGoalTypical
Menu, GoalMenu, Add
Loop, %GOAL_RUNGS% {
    rungVal := GOAL_BASE + A_Index * GOAL_STEP
    rungTxt := Format("{:.4g}", rungVal) . " IVU`t" . A_Index . (A_Index = 1 ? " credit" : " credits")
    Menu, GoalMenu, Add, %rungTxt%, MenuGoalRung
}
Menu, GoalMenu, Add
Menu, GoalMenu, Add, Clear Today's Goal, MenuGoalClear

; --- Submenu: physical keyboard/mouse presence during a study ---
Menu, ActMenu, Add, Turn On,  MenuActOn
Menu, ActMenu, Add, Turn Off, MenuActOff
Menu, ActMenu, Add
Menu, ActMenu, Add, Away after 30s, MenuAct30
Menu, ActMenu, Add, Away after 60s, MenuAct60
Menu, ActMenu, Add, Away after 90s, MenuAct90

; --- Submenu: wellness breaks ---
Menu, WellnessMenu, Add, Where Am I?,     MenuWellnessStatus
Menu, WellnessMenu, Add, Preview a Nudge, MenuTestWellness
Menu, WellnessMenu, Add
Menu, WellnessMenu, Add, Set to 60 min,   MenuWellness60
Menu, WellnessMenu, Add, Set to 90 min,   MenuWellness90
Menu, WellnessMenu, Add
Menu, WellnessMenu, Add, Reset Strain,    MenuWellnessReset

; --- Submenu: what PowerScribe says this work was actually worth ---
; The IVU table is a guess made from prose; PowerScribe's RVU Sum is the
; number that counts. This is where the two get reconciled.
Menu, CalibMenu, Add, Correct Today's Total..., MenuCalibReport
Menu, CalibMenu, Add
Menu, CalibMenu, Add, Clear Today's Correction, MenuCalibClearDay
Menu, CalibMenu, Add, Set IVU per RVU..., MenuCalibScale

; --- Submenu: database maintenance (rare, destructive-ish) ---
Menu, DataMenu, Add, Reset Day Count, MenuResetCount
Menu, DataMenu, Add
Menu, DataMenu, Add, Clean Database,  MenuCleanDB
Menu, DataMenu, Add, Remove Outliers, MenuRemoveOutliers

; --- Submenu: diagnostics (was cluttering the top level) ---
Menu, DiagMenu, Add, Find PACS Controls, MenuFindPACS
Menu, DiagMenu, Add
Menu, DiagMenu, Add, Test Start, MenuTestStart
Menu, DiagMenu, Add, Test Stop,  MenuTestStop

; --- Top level ---
Menu, Tray, Add, Dashboard,       MenuDashboard
Menu, Tray, Add, Show Widget,     MenuShow
Menu, Tray, Add, Snap to Corner,  MenuReposition
Menu, Tray, Add
Menu, Tray, Add, Exam Title,      :ExamMenu
Menu, Tray, Add, Fix Last Study,  :FixLastMenu
Menu, Tray, Add, Undo Last Sign,  MenuUndoLast
Menu, Tray, Add
Menu, Tray, Add, Shifts,            :ShiftMenu
Menu, Tray, Add, Daily Goal,        :GoalMenu
Menu, Tray, Add, Rewards,           :RewardMenu
Menu, Tray, Add, Par `& Overtime,   :SpeedMenu
Menu, Tray, Add, IVU Calibration,   :CalibMenu
Menu, Tray, Add, Activity Tracking, :ActMenu
Menu, Tray, Add, Wellness,          :WellnessMenu
Menu, Tray, Add
Menu, Tray, Add, Data `& Cleanup, :DataMenu
Menu, Tray, Add, Diagnostics,     :DiagMenu
Menu, Tray, Add
Menu, Tray, Add, Exit,            MenuExit
Menu, Tray, Default, Dashboard

; --- Build GUI ---
BuildGUI()
SetModality("CT")
; Initialize IVU display from loaded data
ivuInit := Format("{:.1f}", todayIVU)
GuiControl, Main:, IVUDisplay, %ivuInit%

; Reflect loaded settings in menu checkmarks
ApplySettingsChecks()

; Start background timers
SetTimer, MidnightCheck, 60000
SetTimer, TrackPACSWindow, 1000
SetTimer, TipCheck, 300             ; hover tooltips for the action buttons
SetTimer, FlushPending, 30000       ; CSV retry queue (was dead code below - fixed)
SetTimer, PosSaveCheck, 60000       ; persist widget position if moved
SetTimer, FetchShiftsKick, -3000    ; refresh QGenda schedule shortly after start
SetTimer, WellStrainTimer, 5000     ; desk-strain sampler - runs the whole session
UpdateTrayTip()
return

; --- Scroll over the widget to nudge this study's par. AHK v1 has no dial
;     control and the widget has no room for one, so the wheel costs 0 px.
;     MUST sit BELOW the auto-execute `return`: in AHK v1 a hotkey
;     definition ENDS the auto-execute section, so placing these above
;     BuildGUI() stops the widget from ever being created - script runs,
;     hotkeys work, no window. ---
#If MouseOverWidget()
WheelUp::ParNudge(1)
WheelDown::ParNudge(-1)
#If

; ============================================================
;  PACS WINDOW TRACKER
;  Polls every second to capture the last foreground window
;  that contains a SysListView32 control. Used by the forecast
;  feature so we can read the worklist even after focus shifts
;  to the widget or tray menu.
; ============================================================

TrackPACSWindow:
    WinGet, fgHwnd, ID, A
    if (fgHwnd = 0)
        return
    ; Skip our own widget/popups
    WinGetClass, fgClass, ahk_id %fgHwnd%
    WinGet, fgExe, ProcessName, ahk_id %fgHwnd%
    if (fgExe = "AutoHotkey.exe" || fgExe = "")
        return
    ; Skip explorer (taskbar) and shell windows
    if (fgClass = "Shell_TrayWnd" || fgClass = "WorkerW" || fgClass = "Progman")
        return
    ; Check if this window has a SysListView32 control
    WinGet, ctrls, ControlList, ahk_id %fgHwnd%
    if InStr(ctrls, "SysListView32")
        lastPACSWin := fgHwnd
return

; ============================================================
;  HOTKEYS
; ============================================================

~^!F4::
~F4::
    GoSub, DoStart
return

~F12::
    GoSub, DoStop
return

DoStart:
    ; F4 also toggles PowerScribe's microphone, so mid-study presses are
    ; ignored. But a study open for hours was never signed: without this the
    ; first F4 of the next day is ignored too and the clock keeps counting
    ; from the previous one (a Friday study read 65h on Monday). Dropped, not
    ; logged - its duration is the weekend, not the read.
    staleNote := ""
    if (timerRunning && (A_TickCount - startTick) // 60000 >= STALE_STUDY_MIN) {
        staleFrom := A_Now
        EnvAdd, staleFrom, % -((A_TickCount - startTick) // 1000), Seconds
        FormatTime, staleFrom, %staleFrom%, ddd h:mm tt
        staleNote := "The last study was still open from " . staleFrom
            . " (never signed with F12). Dropped, not logged."
        GoSub, CancelRunningStudy
    }
    if (!timerRunning) {
        ; Cancel any active undo window
        if (undoWindow) {
            undoWindow := false
            SetTimer, UndoExpire, Off
            GuiControl, Main:, BtnReset, % Chr(0x21BA)
        }

        ; Clear exam text for new study
        lastExamText := ""
        ; ...and the order it came from. A stale procedure code is worse
        ; than none: it would silently value this study as the last one.
        psProcCode := ""
        psProcDesc := ""
        psAccession := ""
        lastIVUSrc := ""
        lastMatchScore := 0
        HideExamBanner()

        timerRunning := true
        startTick    := A_TickCount
        ActivityReset()
        ParReset()
        warnThreshold := 0
        warnThreshLocked := false
        warnActive := false
        SetTimer, WarnFlash, Off
        SetTimer, UpdateDisplay, 100

        GuiControl, Main:, TimeDisplay, 00:00
        GuiControl, Main:+c%TXT_RUN%, TimeDisplay

        GuiControl, Main:, StatusDot, % Chr(0x25CF)
        GuiControl, Main:+c%ACCENT_RUN%, StatusDot

        GuiControl, Main:, StatusLabel, DICTATING
        GuiControl, Main:+c%ACCENT_RUN%, StatusLabel

        Gui, Main:Color, %BG_RUN%
        Gui, AccentBar:Color, %ACCENT_RUN%

        UpdateTrayTip()

        ; Look for the exam as soon as PowerScribe plausibly has it, backing
        ; off if not, then verify. See DET_FIND_GAPS / DetectTick.
        detFindIdx := 1
        detVerIdx := 0
        detCaptured := false
        detCapturedText := ""
        examManual := false
        ScheduleDetect(DET_FIND_GAPS, detFindIdx)

        if (staleNote != "") {
            NotifyAtWidget(staleNote)
            SetTimer, ClearToolTip, -8000
        }
    }
return

DelayedDetect:
    DetectTick()
return

DoStop:
    if (timerRunning) {
        ; FIRST: capture exam text from PowerScribe before sign action completes
        ; This catches any changes made since the 10-second auto-detect.
        ; Skipped entirely for a hand-typed title - ReadExamFromPS() writes
        ; lastExamText itself, so guarding only the assignment would still
        ; clobber it.
        if (!examManual) {
            freshExam := ReadExamFromPS()
            if (freshExam != "")
                lastExamText := freshExam
            ; The order's procedure code, which is what PowerScribe bills
            ; against. Skipped for a hand-typed title on the same reasoning
            ; as the text: a typed title means PowerScribe had nothing right
            ; for this study, and the Order Data pane is no more right.
            ReadOrderFromPS()
        }

        SetTimer, DelayedDetect, Off

        ; Final activity slice before the timer stops, then freeze the numbers
        SampleActivity()
        timerRunning := false
        activeSec := Round(studyActiveMs / 1000)
        SetTimer, UpdateDisplay, Off
        SetTimer, DelayedDetect, Off
        RestoreAccentWidth()
        ClearWarning()
        elapsed := (A_TickCount - startTick) // 1000
        ; Physical activity can never exceed the study's own wall time
        if (activeSec > elapsed)
            activeSec := elapsed
        studyCount++
        todayCount++
        ; The CSV keeps full H:MM:SS (LogStudy formats its own); the widget
        ; clock is width-limited, so it gets the short form.
        friendly := FormatClock(elapsed)

        GuiControl, Main:, TimeDisplay, %friendly%
        GuiControl, Main:+c%TXT_DONE%, TimeDisplay

        GuiControl, Main:, StatusDot, % Chr(0x2713)
        GuiControl, Main:+c%ACCENT_DONE%, StatusDot

        GuiControl, Main:, StatusLabel, SIGNED
        GuiControl, Main:+c%ACCENT_DONE%, StatusLabel

        GuiControl, Main:, CountDisplay, %todayCount%

        Gui, Main:Color, %BG_MAIN%
        Gui, AccentBar:Color, %ACCENT_DONE%

        UpdateTrayTip()

        ; Value the study: PowerScribe's own figure for this procedure code
        ; if we have learned one, then the table by code, then the fuzzy
        ; description match. IVU_LookupFull records which of the three
        ; answered, so the log can tell a fact from a guess.
        lastIVU := IVU_LookupFull(lastExamText, examManual ? "" : psProcCode)

        ; Correct modality from exam text if detection was wrong or didn't run
        if (lastExamText != "") {
            correctedMod := ModFromExamText(lastExamText)
            if (correctedMod != "")
                SetModality(correctedMod)
        }

        ; Multi-exam: count linked studies (e.g. foot + ankle = 2)
        todayCount += (lastNumExams - 1)  ; already incremented by 1 above

        ; Track IVU per modality
        todayIVU += lastIVU
        if (currentMod = "CR")
            todayIVU_CR += lastIVU
        else if (currentMod = "CT")
            todayIVU_CT += lastIVU
        else if (currentMod = "MR")
            todayIVU_MR += lastIVU
        else if (currentMod = "US")
            todayIVU_US += lastIVU
        else if (currentMod = "PET")
            todayIVU_PET += lastIVU

        ; Update widget displays
        GuiControl, Main:, CountDisplay, %todayCount%
        ivuRound := Format("{:.1f}", todayIVU)
        GuiControl, Main:, IVUDisplay, %ivuRound%

        ; Flash IVU on the exam banner, then hide after 3s
        UpdateExamBannerIVU(lastIVU)
        SetTimer, HideBannerTimer, -3000

        ; --- Score the bet: engaged time vs the par that was on screen ---
        ; Deliberately scored against the par that was actually displayed, not
        ; a par recomputed from the corrected exam text - the bet can't move
        ; after the fact.
        parLog := (parSec > 0) ? Round(parSec) : 0
        if (parLog > 0) {
            parRunToday++
            if (activeSec <= parLog) {
                parWinsToday++
                parStreak++
                if (parStreak > parBestStreak)
                    parBestStreak := parStreak
                if (parStreak > parBestToday)
                    parBestToday := parStreak
                stxt := "UNDER PAR  " . FormatSeconds(parLog - activeSec)
                if (parStreak > 1)
                    stxt .= "   x" . parStreak
                GuiControl, Main:, StatusLabel, %stxt%
                GuiControl, Main:+c%ACCENT_DONE%, StatusLabel
            } else {
                parStreak := 0
                GuiControl, Main:, StatusLabel, % "OVER PAR  " . FormatSeconds(activeSec - parLog)
                GuiControl, Main:+c%WARN_TXT%, StatusLabel
            }
            SaveSetting("ParStreak", parStreak)
            SaveSetting("ParBestStreak", parBestStreak)
        }

        ; bet is settled - drop the Set-par dialog and hand the slot back to
        ; today's exam count
        if (parDlgOpen) {
            parDlgOpen := false
            Gui, ParDlg:Destroy
        }

        LogTime(elapsed, currentMod, lastExamText, lastIVU, activeSec, parLog, psProcCode, IVUSrcTag())
        UpdateCountArea()   ; timerRunning is false now: slot returns to EXAMS
        UpdateGoalUI()

        ; Refresh averages so the speed-warning threshold stays current
        LoadExamAverages()
        LoadShiftStats()

        ; Clear lastExamText for next study
        lastExamText := ""

        ; Show undo button for 5 seconds
        undoWindow := true
        GuiControl, Main:, BtnReset, % Chr(0x2716)
        SetTimer, UndoExpire, -10000
    }
return

; ============================================================
;  RESET / UNDO BUTTON - dual purpose
;  Normal:      ↺  cancels current timer, no log
;  After sign:  ✖  removes last logged entry (5s window)
; ============================================================

; ============================================================
;  FORECAST - Calculate IVU of selected studies in PACS
;  User selects studies in PACS worklist, clicks ∑ button.
;  Script copies selection to clipboard, parses exam names,
;  looks up IVU for each, shows total + projection.
; ============================================================


; ============================================================
;  OCR FORECAST - For PowerScribe and any visual list
;  Workflow:
;    1) User selects rows in PowerScribe (so they look highlighted)
;    2) Click OCR button on widget
;    3) Banner appears: "Click TOP-LEFT corner of area"
;    4) User clicks top-left of the rows on screen
;    5) Banner: "Click BOTTOM-RIGHT corner"
;    6) User clicks bottom-right
;    7) Brief red flash shows captured region
;    8) Screenshot + Windows OCR + IVU lookup + forecast popup
; ============================================================


; ============================================================
;  PASTE-BASED FORECAST - For PowerScribe and any visual list
;  Workaround for the WinRT/PowerShell OCR limitations.
;  Workflow:
;    1) User presses Win+Shift+S, captures the procedure column
;    2) In the Snipping Tool preview, clicks "Text Actions" then "Copy all text"
;    3) Clicks the OCR button on the widget
;    4) A paste box appears - user presses Ctrl+V to paste
;    5) Script parses the pasted text for exam names + IVUs
; ============================================================

DoOCRForecast:
    Gui, OCRPaste:Destroy
    Gui, OCRPaste:New, +AlwaysOnTop +HwndOCRPasteHwnd
    Gui, OCRPaste:Color, 0F1A2E
    Gui, OCRPaste:Margin, 16, 16

    Gui, OCRPaste:Font, s12 c5DCAA5 Bold, Segoe UI
    Gui, OCRPaste:Add, Text, x16 y10 w560 h22 +BackgroundTrans, Forecast IVU from pasted text

    Gui, OCRPaste:Font, s9 cD0D8E8 Normal, Segoe UI
    Gui, OCRPaste:Add, Text, x16 y36 w560 h60 +BackgroundTrans,
    (LTrim
    Step 1:  Press Win+Shift+S, drag a box around the procedure column rows you want
    Step 2:  In the snip preview, click "Text Actions" then "Copy all text"
    Step 3:  Click below and press Ctrl+V to paste, then click Forecast
    )

    Gui, OCRPaste:Font, s9 cE0E0E8 Normal, Consolas
    Gui, OCRPaste:Add, Edit, vOCRPasteText x16 y100 w560 h220 -E0x200 Multi WantTab,

    Gui, OCRPaste:Font, s10 cFFFFFF Bold, Segoe UI
    Gui, OCRPaste:Add, Button, x340 y330 w110 h30 gOCRPasteCancel, Cancel
    Gui, OCRPaste:Add, Button, x460 y330 w120 h30 gOCRPasteSubmit Default, Forecast

    if (GetWidgetMonitorPos(592, 372, ocx, ocy))
        Gui, OCRPaste:Show, x%ocx% y%ocy% w592 h372, RadTempo - Paste OCR Text
    else
        Gui, OCRPaste:Show, w592 h372, RadTempo - Paste OCR Text
    GuiControl, OCRPaste:Focus, OCRPasteText
return

OCRPasteCancel:
    Gui, OCRPaste:Destroy
return

OCRPasteSubmit:
    GuiControlGet, pastedText,, OCRPasteText
    Gui, OCRPaste:Destroy

    if (Trim(pastedText) = "") {
        MsgBox, 48, RadTempo Forecast, Nothing was pasted.
        return
    }

    forecasts := []
    fcstSum := 0.0
    matchedCount := 0
    unmatchedCount := 0
    unmatchedList := []

    Loop, Parse, pastedText, `n, `r
    {
        line := Trim(A_LoopField)
        if (line = "" || StrLen(line) < 4)
            continue

        ; Find the modality prefix anywhere in the line
        examName := ""
        if RegExMatch(line, "i)\b(XR|CTA|CTV|CT|MRI|MRA|MRV|MR|US|NM|PET|DEXA|MAMMO|FLUORO|FLUOROSCOPY)\b\s+[A-Z]", mod) {
            modPos := InStr(line, mod1)
            if (modPos > 0)
                examName := Trim(SubStr(line, modPos))
        }

        if (examName = "")
            continue

        ; Clean up
        StringReplace, examName, examName, `,, %A_Space%, All
        examName := RegExReplace(examName, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
        examName := RegExReplace(examName, "\s+", " ")
        examName := Trim(examName)

        ivu := IVU_Lookup(examName)
        forecasts.Push({name: examName, ivu: ivu})
        if (ivu > 0) {
            fcstSum += ivu
            matchedCount++
        } else {
            unmatchedCount++
            unmatchedList.Push(examName . " (no match)")
        }
    }

    if (forecasts.MaxIndex() = 0) {
        MsgBox, 48, RadTempo Forecast, No exam names found in the pasted text.`n`nMake sure each line starts with a modality prefix like CT, MR, XR, US, PET.
        return
    }

    ShowForecastDialog(forecasts, fcstSum, matchedCount, unmatchedCount, unmatchedList)
return

DoForecast:
    ; Read selected rows from the last detected PACS worklist.
    ; The TrackPACSWindow timer continuously remembers the last
    ; foreground window with a SysListView32, so we still have
    ; the right window even after focus shifted to our widget.

    if (lastPACSWin = 0 || !WinExist("ahk_id " . lastPACSWin)) {
        MsgBox, 48, RadTempo Forecast, No PACS worklist detected yet.`n`nClick on your PACS worklist window once to bring it to focus, wait a moment, then click ∑.
        return
    }

    pacsWin := "ahk_id " . lastPACSWin

    ; Find a SysListView control - prefer one with selections, then most rows
    WinGet, ctrlList, ControlList, %pacsWin%
    listCtrl := ""
    bestRows := -1
    Loop, Parse, ctrlList, `n
    {
        ctrl := A_LoopField
        if !InStr(ctrl, "SysListView32")
            continue
        ; Check if it has selections
        ControlGet, sel, List, Selected, %ctrl%, %pacsWin%
        ControlGet, cnt, List, Count, %ctrl%, %pacsWin%
        if (sel != "") {
            ; Found one with selections - use immediately
            listCtrl := ctrl
            break
        }
        ; Otherwise track the one with most rows as fallback
        if (cnt > bestRows) {
            bestRows := cnt
            listCtrl := ctrl
        }
    }

    if (listCtrl = "") {
        ; ControlGet found no usable list - try UIA fallback for custom controls
        selectedRows := GetSelectedViaUIA(lastPACSWin)
        if (selectedRows = "") {
            MsgBox, 48, RadTempo Forecast, No readable worklist found.`n`nSectra works directly. PowerScribe Reports view uses a custom control that AHK cannot read - the studies there are already in your CSV anyway.
            return
        }
    } else {
        ; Standard SysListView32 - use ControlGet
        ControlGet, selectedRows, List, Selected, %listCtrl%, %pacsWin%

        ; If selectedRows is empty AND the list reports 0 rows, try UIA fallback
        ; (this catches PowerScribe-style custom controls posing as SysListView32)
        if (selectedRows = "") {
            ControlGet, totalCount, List, Count, %listCtrl%, %pacsWin%
            if (totalCount = 0)
                selectedRows := GetSelectedViaUIA(lastPACSWin)
        }
    }

    if (selectedRows = "") {
        MsgBox, 48, RadTempo Forecast, Nothing selected in the worklist.`n`nSelect one or more studies, then click sigma.`n`n(If you are in PowerScribe Reports, it uses a custom control that AHK cannot read. Use Sectra instead for forecasting.)
        return
    }

    forecasts := []
    totalIVU := 0.0
    matchedCount := 0
    unmatchedCount := 0
    unmatchedList := []

    Loop, Parse, selectedRows, `n
    {
        line := A_LoopField
        if (Trim(line) = "")
            continue

        ; Each row's columns are tab-separated. We collect:
        ; - examCode: a column matching IVU table codes (most reliable)
        ; - examDesc: a column starting with a modality prefix (fallback)
        examCode := ""
        examDesc := ""
        Loop, Parse, line, % A_Tab
        {
            col := Trim(A_LoopField)
            if (col = "")
                continue

            ; Sectra exam codes: uppercase letters/digits, 5-15 chars, no spaces
            ; Examples: CTCHSCRWO, XRABDM2V, MRBRWO, USABD
            if (examCode = "" && RegExMatch(col, "^[A-Z][A-Z0-9]{4,14}$")) {
                ; Verify this code exists in the IVU table
                if (FindIVUByCode(col) > 0)
                    examCode := col
            }

            ; Description: starts with modality prefix (allow Sectra abbreviations)
            if (examDesc = "" && RegExMatch(col, "i)^(XR|CTA?|CTV|MRI|MRA|MRV|MR|US|NM|PET|DEXA|MAMMO|FLUORO|FLUOROSCOPY)\s")) {
                examDesc := col
            }
        }

        ; Use code if found (exact match), else use description
        examName := (examCode != "") ? examCode : examDesc

        if (examName = "") {
            unmatchedCount++
            shortLine := (StrLen(line) > 60) ? SubStr(line, 1, 60) . "..." : line
            unmatchedList.Push(shortLine)
            continue
        }

        ; If we matched by code, get the human description for display
        displayName := examDesc
        if (examCode != "" && displayName = "")
            displayName := examCode

        StringReplace, displayName, displayName, `,, %A_Space%, All
        displayName := RegExReplace(displayName, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
        displayName := Trim(displayName)

        ; Look up IVU - by code if we have one, else fuzzy match the description
        if (examCode != "")
            ivu := FindIVUByCode(examCode)
        else
            ivu := IVU_Lookup(examName)

        forecasts.Push({name: displayName, ivu: ivu})
        if (ivu > 0) {
            totalIVU += ivu
            matchedCount++
        } else {
            unmatchedCount++
            unmatchedList.Push(displayName . " (no match)")
        }
    }

    if (forecasts.MaxIndex() = 0) {
        MsgBox, 48, RadTempo Forecast, Could not parse any exam names from the selection.`n`nThe exam name should start with XR, CT, MR, US, NM, or PET.
        return
    }

    ShowForecastDialog(forecasts, totalIVU, matchedCount, unmatchedCount, unmatchedList)
return

; Placeholder for UI Automation reading.
; PowerScribe Reports uses a custom control (likely WPF or Chromium-based)
; that does not expose row data through standard Windows ControlGet.
; Reading it would require a full UIA COM implementation.
; For now, this returns empty - Sectra works directly via ControlGet.
GetSelectedViaUIA(hwnd) {
    return ""
}

ShowForecastDialog(forecasts, fcstIVU, matchedCount, unmatchedCount, unmatchedList) {
    global  ; assume-global so GUI v-vars work
    totalIVU := fcstIVU  ; save for CalcGoal handler

    Gui, Forecast:Destroy
    Gui, Forecast:+AlwaysOnTop +ToolWindow +HwndForecastHwnd
    Gui, Forecast:Color, 0F1A2E
    Gui, Forecast:Margin, 0, 0

    popW := 480

    ; Header bar
    Gui, Forecast:Add, Text, x0 y0 w%popW% h3 +Background5DCAA5

    Gui, Forecast:Font, s12 c5DCAA5 Bold, Segoe UI
    Gui, Forecast:Add, Text, x16 y14 w300 h22 +BackgroundTrans, % Chr(0x2211) . "  IVU Forecast"

    Gui, Forecast:Font, s8 c4A7A6A Normal, Segoe UI
    studyText := matchedCount . " stud" . (matchedCount = 1 ? "y" : "ies")
    if (unmatchedCount > 0)
        studyText .= " (" . unmatchedCount . " not matched)"
    Gui, Forecast:Add, Text, x16 y38 w400 h14 +BackgroundTrans, %studyText%

    ; Summary cards row
    cardY := 60

    ; Card 1: Forecast total
    fcstStr := Format("{:.1f}", totalIVU)
    Gui, Forecast:Add, Text, x16 y%cardY% w140 h60 +Background152540
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    Gui, Forecast:Add, Text, x24 y%cardY% w130 h14 +BackgroundTrans, % "  FORECAST"
    Gui, Forecast:Font, s18 c5DCAA5 Bold, Segoe UI
    cardTextY := cardY + 16
    Gui, Forecast:Add, Text, x24 y%cardTextY% w130 h30 +BackgroundTrans, %fcstStr%
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    cardSubY := cardY + 42
    Gui, Forecast:Add, Text, x24 y%cardSubY% w130 h14 +BackgroundTrans, IVU from selection

    ; Card 2: Today so far
    todayStr := Format("{:.1f}", todayIVU)
    cardX2 := 168
    Gui, Forecast:Add, Text, x%cardX2% y%cardY% w140 h60 +Background152540
    cardX2T := cardX2 + 8
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    Gui, Forecast:Add, Text, x%cardX2T% y%cardY% w130 h14 +BackgroundTrans, % "  TODAY"
    Gui, Forecast:Font, s18 cE8D44D Bold, Segoe UI
    Gui, Forecast:Add, Text, x%cardX2T% y%cardTextY% w130 h30 +BackgroundTrans, %todayStr%
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    Gui, Forecast:Add, Text, x%cardX2T% y%cardSubY% w130 h14, % todayCount . " studies signed"

    ; Card 3: Projected end of day
    projected := todayIVU + totalIVU
    projStr := Format("{:.1f}", projected)
    cardX3 := 320
    Gui, Forecast:Add, Text, x%cardX3% y%cardY% w140 h60 +Background152540
    cardX3T := cardX3 + 8
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    Gui, Forecast:Add, Text, x%cardX3T% y%cardY% w130 h14 +BackgroundTrans, % "  PROJECTED"
    Gui, Forecast:Font, s18 cAFA9EC Bold, Segoe UI
    Gui, Forecast:Add, Text, x%cardX3T% y%cardTextY% w130 h30 +BackgroundTrans, %projStr%
    Gui, Forecast:Font, s7 c4A7A6A Normal, Segoe UI
    Gui, Forecast:Add, Text, x%cardX3T% y%cardSubY% w130 h14, today + forecast

    ; Block context: typical for the block active right now
    UpdateCurrentBlock()
    typN := 0
    typIVU := GetShiftTypical(currentBlock, typN)
    typY := 128
    if (typIVU > 0 && typN >= 2) {
        typStr := Format("{:.1f}", typIVU)
        blkSoFar := GetTodayBlockIVU(currentBlock)
        shLbl := (currentBlock != "") ? currentBlock : "any block"
        if (StrLen(shLbl) > 26)
            shLbl := SubStr(shLbl, 1, 24) . ".."
        pace := Round(((blkSoFar + totalIVU) / typIVU) * 100)
        paceCol := (pace >= 100) ? "5DCAA5" : ((pace >= 80) ? "E8D44D" : "ED93B1")
        Gui, Forecast:Font, s8 c4A7A6A Normal, Segoe UI
        Gui, Forecast:Add, Text, x16 y%typY% w300 h14 +BackgroundTrans, % "Typical " . shLbl . " block: " . typStr . " IVU  (n=" . typN . ")  |  this block: " . Format("{:.1f}", blkSoFar)
        Gui, Forecast:Font, s8 c%paceCol% Bold, Segoe UI
        Gui, Forecast:Add, Text, x330 y%typY% w140 h14 +BackgroundTrans Right, % "Block+fcst = " . pace . "%"
    }

    ; Goal section
    goalY := 148
    ; Prefill: sum of typicals across all of today's blocks (daily goal)
    goalPrefill := forecastGoal
    if (goalPrefill = "") {
        gttN := 0
        dayTyp := GetTodayTypicalTotal(gttN)
        if (dayTyp > 0)
            goalPrefill := Round(dayTyp)
    }
    Gui, Forecast:Font, s8 cC0C8D8 Normal, Segoe UI
    Gui, Forecast:Add, Text, x16 y%goalY% w100 h18 +BackgroundTrans, Daily IVU goal:
    Gui, Forecast:Add, Edit, vForecastGoal x120 y%goalY% w60 h20 -E0x200 Center Number, % (goalPrefill != "" ? goalPrefill : "")
    Gui, Forecast:Font, s8 c5DCAA5 Bold, Segoe UI
    goalCalcX := 188
    Gui, Forecast:Add, Text, x%goalCalcX% y%goalY% w50 h20 +BackgroundTrans gCalcGoal, [calc]
    Gui, Forecast:Font, s8 cC0C8D8 Normal, Segoe UI
    goalResX := 248
    Gui, Forecast:Add, Text, vGoalResult x%goalResX% y%goalY% w220 h18 +BackgroundTrans, Click [calc] after entering goal

    ; Study list header
    listY := 180
    Gui, Forecast:Font, s8 c4A7A6A Bold, Segoe UI
    Gui, Forecast:Add, Text, x16 y%listY% w400 h14 +BackgroundTrans, BREAKDOWN
    listY += 18

    ; List items (max 12 visible, scroll if more)
    Gui, Forecast:Font, s8 cD0D8E8 Normal, Segoe UI
    maxItems := forecasts.MaxIndex()
    if (maxItems > 14)
        maxItems := 14

    Loop, %maxItems% {
        f := forecasts[A_Index]
        nm := f.name
        if (StrLen(nm) > 50)
            nm := SubStr(nm, 1, 47) . "..."
        ivuStr := (f.ivu > 0) ? Format("{:.2f}", f.ivu) : "?"
        ivuColor := (f.ivu > 0) ? "AFA9EC" : "555577"

        rowY := listY
        Gui, Forecast:Font, s8 cD0D8E8 Normal, Segoe UI
        Gui, Forecast:Add, Text, x16 y%rowY% w380 h14 +BackgroundTrans, %nm%
        Gui, Forecast:Font, s8 c%ivuColor% Bold, Segoe UI
        ivuX := 410
        Gui, Forecast:Add, Text, x%ivuX% y%rowY% w55 h14 +BackgroundTrans Right, %ivuStr%
        listY += 16
    }

    if (forecasts.MaxIndex() > 14) {
        moreCount := forecasts.MaxIndex() - 14
        Gui, Forecast:Font, s7 c555577 Italic, Segoe UI
        Gui, Forecast:Add, Text, x16 y%listY% w380 h14 +BackgroundTrans, % "... and " . moreCount . " more"
        listY += 16
    }

    ; Close button
    listY += 12
    Gui, Forecast:Font, s9 cFFFFFF Bold, Segoe UI
    closeBtnX := popW - 90
    Gui, Forecast:Add, Text, x%closeBtnX% y%listY% w74 h26 +Background2D5A4F +Center gCloseForecast, Close

    popH := listY + 36

    ; Center on the widget's monitor
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    wx := 0
    wy := 0
    SysGet, monCount, MonitorCount
    Loop, %monCount% {
        SysGet, mon, Monitor, %A_Index%
        if (mx >= monLeft && mx < monRight && my >= monTop && my < monBottom) {
            wx := monLeft + ((monRight - monLeft) // 2) - (popW // 2)
            wy := monTop + ((monBottom - monTop) // 2) - (popH // 2)
            break
        }
    }

    Gui, Forecast:Show, x%wx% y%wy% w%popW% h%popH% NoActivate, RadTempo Forecast
}

CalcGoal:
    GuiControlGet, goalVal,, ForecastGoal
    if (goalVal = "" || goalVal = 0) {
        GuiControl, Forecast:, GoalResult, Enter a number first
        return
    }
    forecastGoal := goalVal  ; remember for next time
    SaveSetting("ForecastGoal", goalVal)
    projected := todayIVU + totalIVU
    if (projected >= goalVal) {
        excess := Format("{:.1f}", projected - goalVal)
        GuiControl, Forecast:+c5DCAA5, GoalResult
        GuiControl, Forecast:, GoalResult, % Chr(0x2713) . " Goal met! +" . excess . " over target"
    } else {
        needed := Format("{:.1f}", goalVal - projected)
        GuiControl, Forecast:+cE8D44D, GoalResult
        GuiControl, Forecast:, GoalResult, % "Need " . needed . " more IVU after this batch"
    }
return

CloseForecast:
ForecastGuiClose:
    Gui, Forecast:Destroy
return

DoReset:
    if (undoWindow) {
        ; --- UNDO MODE: remove last CSV entry ---
        undoWindow := false
        SetTimer, UndoExpire, Off
        GuiControl, Main:, BtnReset, % Chr(0x21BA)

        if !FileExist(LOG_FILE) {
            ToolTip, Nothing to undo, 0, 0
            SetTimer, ClearToolTip, -1500
            return
        }

        FileRead, csvData, %LOG_FILE%
        lines := StrSplit(csvData, "`n", "`r")

        ; Find last non-empty line
        lastIdx := 0
        for i, line in lines {
            if (line != "")
                lastIdx := i
        }
        if (lastIdx < 2) {
            ToolTip, No entries to undo, 0, 0
            SetTimer, ClearToolTip, -1500
            return
        }

        ; Grab info before removing
        fields := StrSplit(lines[lastIdx], ",")
        removedMod := fields[7]
        removedTime := fields[6]
        removedIVU := (fields.MaxIndex() >= 10) ? fields[10] + 0.0 : 0.0

        ; Remove last line
        lines.RemoveAt(lastIdx)

        ; Rebuild file
        output := ""
        for i, line in lines {
            if (line != "")
                output .= line . "`n"
        }

        FileDelete, %LOG_FILE%
        FileAppend, %output%, %LOG_FILE%

        ; Decrement counters
        if (todayCount > 0)
            todayCount--
        todayIVU -= removedIVU
        if (todayIVU < 0)
            todayIVU := 0.0
        if (removedMod = "CR")
            todayIVU_CR -= removedIVU
        else if (removedMod = "CT")
            todayIVU_CT -= removedIVU
        else if (removedMod = "MR")
            todayIVU_MR -= removedIVU
        else if (removedMod = "US")
            todayIVU_US -= removedIVU
        else if (removedMod = "PET")
            todayIVU_PET -= removedIVU
        GuiControl, Main:, CountDisplay, %todayCount%
        ivuRound := Format("{:.1f}", todayIVU)
        GuiControl, Main:, IVUDisplay, %ivuRound%

        ; Reset display to idle
        GuiControl, Main:, TimeDisplay, --:--
        GuiControl, Main:+c%TXT_IDLE%, TimeDisplay
        GuiControl, Main:, StatusDot, % Chr(0x25CB)
        GuiControl, Main:+c%TXT_LABEL%, StatusDot
        GuiControl, Main:, StatusLabel, READY
        GuiControl, Main:+c%TXT_LABEL%, StatusLabel
        Gui, Main:Color, %BG_MAIN%
        Gui, AccentBar:Color, %ACCENT_IDLE%
        RestoreAccentWidth()

        ToolTip, % "Undone: " . removedMod . " " . removedTime, 0, 0
        SetTimer, ClearToolTip, -2000
    } else {
        ; --- NORMAL RESET: cancel current timer ---
        GoSub, CancelRunningStudy
        ToolTip, Timer reset, 0, 0
        SetTimer, ClearToolTip, -1500
    }
return

; Stop the running study without logging it and put the widget back to
; READY. Shared by the reset button and by F4 dropping a stale study.
CancelRunningStudy:
    timerRunning := false
    SetTimer, DelayedDetect, Off
    if (parDlgOpen) {
        parDlgOpen := false
        Gui, ParDlg:Destroy
    }
    SetTimer, UpdateDisplay, Off
    ActivityReset()
    ParReset()
    UpdateCountArea()
    RestoreAccentWidth()
    ClearWarning()
    startTick := 0
    elapsed := 0

    GuiControl, Main:, TimeDisplay, --:--
    GuiControl, Main:+c%TXT_IDLE%, TimeDisplay
    GuiControl, Main:, StatusDot, % Chr(0x25CB)
    GuiControl, Main:+c%TXT_LABEL%, StatusDot
    GuiControl, Main:, StatusLabel, READY
    GuiControl, Main:+c%TXT_LABEL%, StatusLabel
    Gui, Main:Color, %BG_MAIN%
    Gui, AccentBar:Color, %ACCENT_IDLE%
    Menu, Tray, Tip, RadTempo
return

; --- Undo window expires after 5 seconds, revert button ---
UndoExpire:
    undoWindow := false
    GuiControl, Main:, BtnReset, % Chr(0x21BA)
return

; ============================================================
;  READ EXAM TEXT FROM POWERSCRIBE
;  Reads controls non-invasively, extracts the EXAMINATION
;  field text, strips dates and commas. Used by both
;  DetectModality (7s after F4) and DoStop (at F12).
; ============================================================

ReadExamFromPS() {
    global lastExamText

    psWin := "ahk_exe Nuance.PowerScribe360.exe"
    if !WinExist(psWin)
        return ""

    ; Read all visible text from RichEdit/Static/Edit controls
    examText := ""
    WinGet, ctrlList, ControlList, %psWin%
    Loop, Parse, ctrlList, `n
    {
        ctrl := A_LoopField
        if (ctrl = "")
            continue
        if (InStr(ctrl, "RICHEDIT") || InStr(ctrl, "Edit") || InStr(ctrl, "Static") || InStr(ctrl, "STATIC")) {
            ControlGetText, ctrlText, %ctrl%, %psWin%
            if (ctrlText != "") {
                StringUpper, ctrlTextU, ctrlText
                if (InStr(ctrlTextU, "EXAMINATION") || InStr(ctrlTextU, " CT ") || InStr(ctrlTextU, " MR") || InStr(ctrlTextU, "X-RAY") || InStr(ctrlTextU, "PET") || InStr(ctrlTextU, "NM ") || InStr(ctrlTextU, "ULTRASOUND")) {
                    examText .= ctrlText . "`n"
                    ; The extractor only ever uses the EXAMINATION line, so
                    ; stop walking controls once we have it. This is called
                    ; several times per study now, not once.
                    if (InStr(ctrlTextU, "EXAMINATION"))
                        break
                }
            }
        }
    }

    if (examText = "")
        return ""

    ; Extract exam description after "EXAMINATION:" label
    StringUpper, examUpper, examText
    examPos := InStr(examUpper, "EXAMINATION")
    if (examPos) {
        afterExam := SubStr(examText, examPos + 11)
        afterExam := RegExReplace(afterExam, "^[\s:]+", "")
        nlPos := InStr(afterExam, "`n")
        if (nlPos > 0)
            afterExam := SubStr(afterExam, 1, nlPos - 1)
        if (StrLen(afterExam) > 300)
            afterExam := SubStr(afterExam, 1, 300)
        StringReplace, afterExam, afterExam, `,, %A_Space%, All
        afterExam := RegExReplace(afterExam, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
        lastExamText := Trim(afterExam)
    } else {
        firstLine := examText
        nlPos := InStr(firstLine, "`n")
        if (nlPos > 0)
            firstLine := SubStr(firstLine, 1, nlPos - 1)
        if (StrLen(firstLine) > 300)
            firstLine := SubStr(firstLine, 1, 300)
        StringReplace, firstLine, firstLine, `,, %A_Space%, All
        firstLine := RegExReplace(firstLine, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
        lastExamText := Trim(firstLine)
    }

    return lastExamText
}

; ============================================================
;  AUTO-DETECT MODALITY FROM POWERSCRIBE
; ============================================================

; Arm the next detect attempt from a gap list. idx is 1-based; running off the
; end simply stops polling.
ScheduleDetect(gapsCsv, idx) {
    arr := StrSplit(gapsCsv, ",")
    if (idx < 1 || idx > arr.MaxIndex())
        return
    ms := -1000 * (arr[idx] + 0)
    SetTimer, DelayedDetect, %ms%
}

; One detect attempt. Two phases: find the exam, then verify it did not change
; underneath us (PowerScribe finishing its load after we first looked).
DetectTick() {
    global timerRunning, DET_FIND_GAPS, DET_VER_GAPS, detFindIdx, detVerIdx
    global detCaptured, detCapturedText, lastExamText
    global parLocked, parBase, parSec, parAdjust

    if (!timerRunning)
        return

    got := DetectModality()

    if (!detCaptured) {
        if (got && lastExamText != "") {
            detCaptured := true
            detCapturedText := lastExamText
            detVerIdx := 1
            ScheduleDetect(DET_VER_GAPS, detVerIdx)
        } else {
            detFindIdx++
            ScheduleDetect(DET_FIND_GAPS, detFindIdx)
        }
        return
    }

    ; --- verify phase ---
    if (lastExamText != "" && lastExamText != detCapturedText) {
        ; The first read was of whatever PowerScribe still had on screen, not
        ; this study. Everything derived from it was wrong, so re-derive -
        ; including par. This is not "moving the bet": there was never a valid
        ; bet on the wrong exam. Any manual nudge is dropped for the same
        ; reason - it was made against a different study.
        detCapturedText := lastExamText
        parLocked := false
        parBase := 0
        parSec := 0
        parAdjust := 0
        ToolTip, % "Exam corrected: " . lastExamText, 0, 0
        SetTimer, ClearToolTip, -2500
    }
    detVerIdx++
    ScheduleDetect(DET_VER_GAPS, detVerIdx)
}

; Manual re-fetch of the exam title, from the menu.
; The automatic search gives up after DET_FIND_GAPS and the verify passes are
; done about a minute in, so once PowerScribe registers the study LATE there is
; nothing still watching for it. This restarts the whole find/verify cycle by
; hand. Par and the overtime threshold are released when the title actually
; changes, because a bet made against the wrong exam type was never a valid bet
; on this study - the same reasoning the automatic verify pass uses.
ForceRefetchExam() {
    global timerRunning, lastExamText, currentMod
    global detCaptured, detCapturedText, detFindIdx, detVerIdx
    global DET_FIND_GAPS, DET_VER_GAPS
    global warnThreshold, warnThreshLocked, examManual

    if (!timerRunning) {
        NotifyAtWidget("No study running - nothing to re-fetch.")
        return
    }

    SetTimer, DelayedDetect, Off       ; drop whichever pass was already armed
    examManual := false                ; asking for a re-fetch means trust PS again
    before := lastExamText

    if (ReadExamFromPS() = "") {
        ; Nothing readable at all. Restart the search from the top so it keeps
        ; trying on its own rather than dying here.
        detCaptured := false
        detCapturedText := ""
        detFindIdx := 1
        detVerIdx := 0
        ScheduleDetect(DET_FIND_GAPS, detFindIdx)
        NotifyAtWidget("PowerScribe gave nothing back.`nStill looking - it will land on its own if it shows up.")
        return
    }

    ; ReadExamFromPS() has set lastExamText; let DetectModality do the banner,
    ; the IVU preview and the modality switch exactly as the auto path does.
    DetectModality()
    detCapturedText := lastExamText

    if (lastExamText != before) {
        ParReset()
        warnThreshold := 0
        warnThreshLocked := false
        NotifyAtWidget("Exam: " . lastExamText . "`nPar and overtime re-derived.")
    } else {
        NotifyAtWidget("Unchanged: " . lastExamText)
    }

    ; Re-arm the verify passes so a later change still gets caught.
    detCaptured := true
    detVerIdx := 1
    ScheduleDetect(DET_VER_GAPS, detVerIdx)
}

; Last resort, when PowerScribe never registers the study at all: type the title.
; Everything downstream keys off lastExamText - the log row, the IVU lookup, the
; modality and par - so setting it here feeds all four. PowerScribe is then left
; alone for the rest of the study (see examManual).
SetExamTitleManually() {
    global timerRunning, lastExamText, warnThreshold, warnThreshLocked
    global examManual, detCaptured, detCapturedText

    if (!timerRunning) {
        NotifyAtWidget("No study running - nothing to title.")
        return
    }

    GetWidgetMonitorPos(400, 200, ex, ey)
    InputBox, newTitle, Exam Title, % "Exam description for the study you are reading.`n`nThis feeds the log, the IVU lookup, the modality and par.`nPowerScribe will not be read again for this study.", , 400, 200, %ex%, %ey%, , , %lastExamText%
    if (ErrorLevel)
        return
    newTitle := Trim(newTitle)
    if (newTitle = "")
        return

    SetTimer, DelayedDetect, Off       ; nothing may overwrite a typed title
    examManual := true
    lastExamText := newTitle
    detCaptured := true
    detCapturedText := newTitle

    ShowExamBanner(lastExamText)
    ; No procedure code: a typed title is only entered when PowerScribe
    ; has nothing right for this study, order pane included.
    UpdateExamBannerIVU(IVU_LookupFull(lastExamText, ""))
    manMod := ModFromExamText(lastExamText)
    if (manMod != "")
        SetModality(manMod)
    ParReset()
    warnThreshold := 0
    warnThreshLocked := false
    NotifyAtWidget("Exam set: " . lastExamText . "`nPar and overtime re-derived.")
}

; Returns 1 when a usable exam text is in hand, 0 otherwise.
DetectModality() {
    global currentMod, lastExamText, examManual, psProcCode

    ; Read exam text from PowerScribe
    examText := ReadExamFromPS()
    if (examText = "")
        return 0

    ; Show exam text in banner if captured, with preview IVU. The order
    ; is read here too so the preview is the same number that gets logged
    ; - only on ticks that actually found text, so it costs one control
    ; scan per study rather than one per polling attempt.
    if (lastExamText != "") {
        ShowExamBanner(lastExamText)
        if (!examManual)
            ReadOrderFromPS()
        previewIVU := IVU_LookupFull(lastExamText, examManual ? "" : psProcCode)
        UpdateExamBannerIVU(previewIVU)
    }

    ; --- Detect modality ---
    ; If we captured clean exam text, use that (most reliable)
    if (lastExamText != "") {
        detected := ModFromExamText(lastExamText)
    } else {
        ; Fall back to broad control text scan
        detected := ""

        ; PET first (most specific - require clear PET indicators)
        if (InStr(examText, "PET/CT") || InStr(examText, "PET /CT") || InStr(examText, "NM PET") || RegExMatch(examText, "\bPET\b") || InStr(examText, "POSITRON"))
            detected := "PET"

        ; MRI / MR
        else if (InStr(examText, "MRI") || RegExMatch(examText, "\bMRCP\b") || InStr(examText, "MAGNETIC RESONANCE"))
            detected := "MR"

        ; CT (but NOT PET/CT - already caught above)
        else if (RegExMatch(examText, "\bCTA?\b") || InStr(examText, "COMPUTED TOMOGRAPHY"))
            detected := "CT"

        ; Ultrasound
        else if (InStr(examText, "ULTRASOUND") || InStr(examText, "SONOGRAPH"))
            detected := "US"

        ; X-ray / CR / Fluoro (last - broad matches)
        else if (InStr(examText, "X-RAY") || InStr(examText, "XRAY") || RegExMatch(examText, "\bXR\b") || InStr(examText, "RADIOGRAPH") || InStr(examText, "FLUORO") || InStr(examText, "BARIUM") || InStr(examText, "HSG") || InStr(examText, "DEXA") || InStr(examText, "MAMMO"))
            detected := "CR"
    }

    if (detected != "") {
        SetModality(detected)
        ToolTip, Auto: %detected%, 0, 0
        SetTimer, ClearToolTip, -2000
    }
    return (lastExamText != "") ? 1 : 0
}

; ============================================================
; ============================================================
;  MODALITY BUTTON HANDLERS
; ============================================================

; Single handler for all modality buttons - identifies which by A_GuiControl
ModBtnClick:
    clickedIdx := 0
    if RegExMatch(A_GuiControl, "ModBtn(\d+)", mbm)
        clickedIdx := mbm1
    if (clickedIdx >= 1 && clickedIdx <= MODS.MaxIndex())
        SetModality(MODS[clickedIdx])
return

; --- / and . cycle modalities (global, but only act when widget is active) ---

$/::
    IfWinActive, RadTempo
    {
        GoSub, CycleModForward
    }
    else
    {
        Send {/}
    }
return

$.::
    IfWinActive, RadTempo
    {
        GoSub, CycleModBackward
    }
    else
    {
        Send {.}
    }
return

CycleModForward:
    modIndex := Mod(modIndex, MODS.MaxIndex()) + 1
    SetModality(MODS[modIndex])
return

CycleModBackward:
    modIndex := modIndex - 1
    if (modIndex < 1)
        modIndex := MODS.MaxIndex()
    SetModality(MODS[modIndex])
return

SetModality(mod) {
    global currentMod, modIndex, MODS, MOD_TXT, SEG_BG
    currentMod := mod

    ; Sync modIndex
    for i, m in MODS {
        if (m = mod)
            modIndex := i
    }

    ; Active segment fills with its modality colour and flips to dark ink; the
    ; rest sit on the shared face colour. Both the fill and the text colour are
    ; set, so if a given Windows/theme combination refuses the runtime
    ; background change the selection still reads via the text colour rather
    ; than disappearing.
    for i, m in MODS {
        ; AHK v1: a forced-expression parameter must START with "% ", so the
        ; whole "Main:+Background<hex>" option has to be built first - writing
        ; GuiControl, Main:% expr is a syntax error.
        if (m = mod) {
            bgOpt := "Main:+Background" . ModColor(m)
            GuiControl, % bgOpt, ModBtn%i%
            GuiControl, Main:+c0B0B16, ModBtn%i%
        } else {
            bgOpt := "Main:+Background" . SEG_BG
            GuiControl, % bgOpt, ModBtn%i%
            GuiControl, Main:+c%MOD_TXT%, ModBtn%i%
        }
        GuiControl, Main:MoveDraw, ModBtn%i%
    }
}

; Modality -> palette hex (same hues the dashboard uses for each modality)
ModColor(m) {
    if (m = "CR")
        return "199E70"
    if (m = "CT")
        return "C98500"
    if (m = "MR")
        return "3987E5"
    if (m = "US")
        return "D55181"
    if (m = "PET")
        return "9085E9"
    return "B8B8CF"
}

; ============================================================
;  DISPLAY UPDATE
; ============================================================

UpdateDisplay:
    if (timerRunning) {
        secs := (A_TickCount - startTick) // 1000
        GuiControl, Main:, TimeDisplay, % FormatClock(secs)
        SampleActivity()
        UpdateActivityUI()

        ; --- Par: lock once the exam type is actually known. Same race the
        ;     speed warning has always had - the exam text lands ~10s in, so
        ;     locking on tick 1 would inherit the PREVIOUS study's modality.
        if (PAR_ENABLED && !parLocked) {
            basePar := GetPar(lastExamText, currentMod)
            if (basePar > 0) {
                parBase := basePar
                parSec := basePar + parAdjust
                if (parSec < 30)
                    parSec := 30
                if (lastExamText != "")
                    parLocked := true
            }
        }

        UpdateCountArea()

        ; --- Speed warning check ---
        if (warnEnabled && !warnActive) {
            ; Keep recomputing until we actually know the study type.
            ; The exam text is captured ~10s in (banner detection), and
            ; currentMod is corrected then too. Locking the threshold on
            ; the first tick would use the PREVIOUS study's modality and
            ; fire far too early (e.g. a PET blinking at the CR threshold).
            if (warnThreshold = 0 || !warnThreshLocked) {
                warnThreshold := GetWarnThreshold(lastExamText, currentMod)
                if (lastExamText != "")
                    warnThreshLocked := true
            }
            ; Only fire once the threshold is based on a real exam type.
            ; This prevents a stale currentMod from tripping the warning
            ; before this study's exam has been detected. If exam text
            ; never resolves (detection failed), fall back to the modality
            ; threshold after a 20s grace period so the warning still works.
            fireOK := warnThreshLocked
            if (!fireOK && secs > 20 && warnThreshold > 0)
                fireOK := true
            actSecsNow := Round(studyActiveMs / 1000)
            if (fireOK && warnThreshold > 0 && actSecsNow > warnThreshold) {
                warnActive := true
                warnFlashState := false
                SetTimer, WarnFlash, 500
            }
        }
    }
return

; Flashing warning when a study runs past its average time
WarnFlash:
    if (!warnActive || !timerRunning) {
        SetTimer, WarnFlash, Off
        return
    }
    warnFlashState := !warnFlashState
    if (warnFlashState) {
        Gui, Main:Color, %WARN_BG_B%
        Gui, AccentBar:Color, %WARN_BG_B%
        GuiControl, Main:+c%WARN_TXT%, TimeDisplay
        GuiControl, Main:, StatusLabel, OVER TIME
        GuiControl, Main:+cFFFFFF, StatusLabel
    } else {
        Gui, Main:Color, %WARN_BG_A%
        Gui, AccentBar:Color, %WARN_BG_A%
        GuiControl, Main:+cFFFFFF, TimeDisplay
        GuiControl, Main:+c%WARN_TXT%, StatusLabel
    }
return

; Clear the warning state and restore running colors
ClearWarning() {
    global
    if (warnActive || warnThreshold > 0) {
        SetTimer, WarnFlash, Off
        warnActive := false
    }
    warnThreshold := 0
    warnThreshLocked := false
    warnFlashState := false
}

; ============================================================
;  MIDNIGHT RESET - check every 60s
; ============================================================

MidnightCheck:
    FormatTime, curDate,, yyyyMMdd
    if (lastDate = "")
        lastDate := curDate
    if (curDate != lastDate) {
        todayCount := 0
        studyCount := 0
        todayIVU := 0.00
        todayIVU_CR := 0.00
        todayIVU_CT := 0.00
        todayIVU_MR := 0.00
        todayIVU_US := 0.00
        todayIVU_PET := 0.00
        GuiControl, Main:, CountDisplay, 0
        GuiControl, Main:, IVUDisplay, 0.0
        ; New day: strain carries over (the body does not reset at midnight),
        ; but the per-day break count starts fresh.
        breaksToday := 0
        parWinsToday := 0
        parRunToday := 0
        parBestToday := 0
        FormatTime, breaksDate,, yyyy-MM-dd
        lastDate := curDate
        ; New day: refetch schedule
        SetTimer, FetchShiftsKick, -5000
    }
    ; Track the active block (AM/PM flip, call windows) every minute
    prevBlock := currentBlock
    UpdateCurrentBlock()
    if (currentBlock != prevBlock)
        UpdateTrayTip()
return

; ============================================================
;  GUI BUILD
; ============================================================

; ============================================================
;  PHYSICAL-ACTIVITY TRACKING
;  Are real hands on the hardware during this study?
; ============================================================

; Reset the per-study accumulators. Called whenever a study begins or is reset.
ActivityReset() {
    global studyActiveMs, studyAwayMs, actLastTick, actAwayRunMs
    studyActiveMs := 0
    studyAwayMs   := 0
    actAwayRunMs  := 0
    actLastTick   := A_TickCount
}

; Accumulate the elapsed slice into active or away. Driven by UpdateDisplay
; (100ms while a study runs), so the slice is small and the split is precise.
SampleActivity() {
    global ACT_ENABLED, ACT_IDLE_MS, studyActiveMs, studyAwayMs, actLastTick, actAwayRunMs
    now := A_TickCount
    if (!actLastTick) {
        actLastTick := now
        return
    }
    delta := now - actLastTick
    actLastTick := now
    if (delta <= 0)
        return
    ; Clock jumps / resume-from-sleep: don't dump a huge slice into either bucket
    if (delta > 5000)
        delta := 5000
    if (!ACT_ENABLED) {
        studyActiveMs += delta
        return
    }
    idleMs := A_TimeIdlePhysical
    if (idleMs < ACT_IDLE_MS) {
        studyActiveMs += delta
        actAwayRunMs := 0
    } else {
        studyAwayMs  += delta
        actAwayRunMs += delta
    }
}

; Put the accent bar back to full width. The bar doubles as a focus meter
; while a study runs, so every exit path (sign, reset, undo) must restore it
; or the next study starts with a stale partial bar.
RestoreAccentWidth() {
    global GUI_W, GUI_H, AccentHwnd, MainHwnd
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    if (mx != "")
        WinMove, ahk_id %AccentHwnd%,, %mx%, % my + GUI_H - 3, %GUI_W%, 3
}

; Share of the current study spent active, 0-100. 100 when nothing measured yet.
ActivityPct() {
    global studyActiveMs, studyAwayMs
    tot := studyActiveMs + studyAwayMs
    if (tot <= 0)
        return 100
    return Round(studyActiveMs * 100 / tot)
}

; Live widget feedback: the accent bar doubles as a focus meter (its width is
; the active share), the status dot reports the instantaneous state, and the
; status label surfaces a sustained absence.
UpdateActivityUI() {
    global ACT_ENABLED, ACT_IDLE_MS, GUI_W, GUI_H, AccentHwnd, MainHwnd, actAwayRunMs
    global parSec, studyActiveMs, WARN_PCT, ACCENT_RUN, WARN_TXT, ACT_DOT_ON, warnActive
    global warnActive, ACT_DOT_ON, ACT_DOT_OFF, timerRunning
    if (!ACT_ENABLED || !timerRunning)
        return
    pct := ActivityPct()
    actSecs := Round(studyActiveMs / 1000)
    ; The accent bar is the race: it fills with engaged time toward par.
    ; (Focus % barely moves once you are working, so it made a poor bar;
    ;  par progress is monotonic and is the thing you are playing against.)
    if (parSec > 0) {
        barPct := Round(actSecs / parSec * 100)
        if (barPct > 100)
            barPct := 100
        barW := Round(GUI_W * barPct / 100)
        parRatio := actSecs / parSec
        barCol := (parRatio <= 1.0) ? ACT_DOT_ON : ((parRatio <= (WARN_PCT / 100.0)) ? ACCENT_RUN : WARN_TXT)
    } else {
        barW := Round(GUI_W * pct / 100)
        barCol := ACCENT_RUN
    }
    if (barW < 6)
        barW := 6
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    if (mx != "")
        WinMove, ahk_id %AccentHwnd%,, %mx%, % my + GUI_H - 3, %barW%, 3
    ; AccentBar is its own GUI window, not a control - recolour with Gui,Color.
    ; Skip while the overtime flash is running: that owns the colour and the
    ; two would fight each other every tick.
    if (!warnActive)
        Gui, AccentBar:Color, %barCol%
    away := (A_TimeIdlePhysical >= ACT_IDLE_MS)
    GuiControl, Main:, StatusDot, % away ? Chr(0x25CB) : Chr(0x25CF)
    dotOpt := "Main:+c" . (away ? ACT_DOT_OFF : ACT_DOT_ON)
    GuiControl, % dotOpt, StatusDot
    ; Don't fight the overtime warning for the status line
    if (!warnActive) {
        if (away) {
            GuiControl, Main:, StatusLabel, % "AWAY " . FormatSeconds(actAwayRunMs // 1000)
        } else if (parSec > 0) {
            ; golf scoring: how far under/over par you are on engaged time
            ; MID-STUDY this is a countdown, not a verdict: how much engaged
            ; time is left before par. Labelled LEFT rather than UNDER, because
            ; "UNDER" read like "you are N minutes under your average", which
            ; it never was - it is distance to a target you can move.
            ; The UNDER PAR / OVER PAR verdict is only shown once signed.
            dlt := Round(parSec) - actSecs
            scoreTxt := (dlt >= 0) ? (FormatSeconds(dlt) . " LEFT") : (FormatSeconds(-dlt) . " OVER")
            GuiControl, Main:, StatusLabel, % pct . "%  " . Chr(0x00B7) . "  " . scoreTxt
        } else {
            GuiControl, Main:, StatusLabel, % pct . "%  " . Chr(0x00B7) . "  par --"
        }
    }
}

BuildGUI() {
    global

    ; Guard against accidental re-entry (double-create = control name clash)
    static guiBuilt := false
    if (guiBuilt)
        return
    guiBuilt := true

    ; --- Find rightmost monitor ---
    SysGet, monCount, MonitorCount
    maxRight   := -999999
    bestBottom := 0
    Loop, %monCount% {
        SysGet, mon, Monitor, %A_Index%
        if (monRight > maxRight) {
            maxRight   := monRight
            bestBottom := monBottom
        }
    }

    posX := maxRight   - GUI_W - 20
    posY := bestBottom - GUI_H - 55

    ; Restore saved position if valid and still on-screen
    IniRead, savedX, %INI_FILE%, Window, PosX, %A_Space%
    IniRead, savedY, %INI_FILE%, Window, PosY, %A_Space%
    if (savedX != "" && savedY != "" && savedX != "ERROR") {
        Loop, %monCount% {
            SysGet, mon, Monitor, %A_Index%
            if (savedX >= monLeft - 10 && savedX < monRight && savedY >= monTop - 10 && savedY < monBottom) {
                posX := savedX
                posY := savedY
                break
            }
        }
    }
    lastSavedPosX := posX
    lastSavedPosY := posY

    ; =============================================
    ;  Main window
    ; =============================================
    Gui, Main:+AlwaysOnTop +ToolWindow -Caption +HwndMainHwnd +LabelMain
    Gui, Main:Color, %BG_MAIN%
    Gui, Main:Margin, 0, 0

    ; =============================================
    ;  ZONE 1 - live state: timer on the left,
    ;  today's totals as a right-aligned key/value
    ;  column. Nothing else competes with these.
    ; =============================================
    Gui, Main:Font, s9 c%TXT_LABEL% Normal, Segoe UI Symbol
    Gui, Main:Add, Text, vStatusDot x8 y12 w12 h14 +BackgroundTrans, % Chr(0x25CB)

    Gui, Main:Font, s21 c%TXT_IDLE% Bold, Segoe UI
    Gui, Main:Add, Text, vTimeDisplay x22 y1 w112 h30 +BackgroundTrans, --:--

    Gui, Main:Font, s8 c%TXT_LABEL% Bold, Segoe UI
    Gui, Main:Add, Text, vStatusLabel x23 y32 w132 h13 +BackgroundTrans, READY

    ; This slot shows today's exam count when idle and flips to PAR while a
    ; study is running - par has to be a VISIBLE NUMBER you can point at, not
    ; an invisible target you can only feel through a delta.
    Gui, Main:Font, s7 c%TXT_LABEL% Normal, Segoe UI
    Gui, Main:Add, Text, vCountLabel hwndhTipPar x132 y8 w52 h12 +BackgroundTrans Right gParClick, EXAMS
    Gui, Main:Font, s13 c%TXT_COUNT% Bold, Segoe UI
    Gui, Main:Add, Text, vCountDisplay hwndhTipPar2 x188 y5 w56 h18 +BackgroundTrans Right gParClick, %todayCount%

    Gui, Main:Font, s7 c%TXT_LABEL% Normal, Segoe UI
    Gui, Main:Add, Text, vIVULabel x132 y26 w52 h12 +BackgroundTrans Right, IVU
    Gui, Main:Font, s13 c%TXT_IVU% Bold, Segoe UI
    Gui, Main:Add, Text, vIVUDisplay x188 y23 w56 h18 +BackgroundTrans Right gShowIVUBreakdown, 0.0

    ; =============================================
    ;  ZONE 2 - controls. Modality is a contiguous
    ;  segmented strip; the three actions sit in
    ;  their own cluster separated by a deliberate
    ;  gap, so picking a modality and firing an
    ;  action never read as one undifferentiated
    ;  row of glyphs. Both share one face colour so
    ;  the row reads as buttons, not decoration.
    ; =============================================
    segY := 52
    segH := 18
    segW := 26

    Gui, Main:Font, s8 c%MOD_TXT% Bold, Segoe UI
    Loop, % MODS.MaxIndex() {
        m := MODS[A_Index]
        x := 6 + (A_Index - 1) * (segW + 1)
        Gui, Main:Add, Text, vModBtn%A_Index% x%x% y%segY% w%segW% h%segH% Background%SEG_BG% +Center gModBtnClick, %m%
    }

    ; Action cluster, right-aligned, 12px clear of the modality strip.
    ; Every one of these glyphs is cryptic on its own, so all four carry a
    ; hover tooltip (see TipCheck) - no gesture is discoverable by guessing.
    Gui, Main:Font, s10 c5DCAA5 Bold, Segoe UI
    Gui, Main:Add, Text, vBtnForecast hwndhTipFc x152 y%segY% w22 h%segH% Background%SEG_BG% +Center gDoForecast, % Chr(0x2211)

    Gui, Main:Font, s9 c85B7EB Bold, Segoe UI
    Gui, Main:Add, Text, vBtnOCR hwndhTipOcr x176 y%segY% w22 h%segH% Background%SEG_BG% +Center gDoOCRForecast, % Chr(0x25A3)

    ; Position reset. A visible single-click button on purpose: this used to be
    ; a double-click on a grip glyph, which was undiscoverable and could fire
    ; by accident while dragging.
    Gui, Main:Font, s10 c9AA6C8 Bold, Segoe UI Symbol
    Gui, Main:Add, Text, vBtnHome hwndhTipHome x224 y%segY% w22 h%segH% Background%SEG_BG% +Center gDoSnapHome, % Chr(0x21F2)

    Gui, Main:Font, s10 c%WARN_TXT% Normal, Segoe UI Symbol
    Gui, Main:Add, Text, vBtnReset hwndhTipReset x200 y%segY% w22 h%segH% Background%SEG_BG% +Center gDoReset, % Chr(0x21BA)

    ; hwnd -> tooltip text, consumed by the TipCheck timer.
    ; No `global tipMap` here: BuildGUI() is already in assume-global mode
    ; (bare `global` at the top), and AHK v1 forbids mixing the two.
    tipMap := {}
    tipMap[hTipFc]    := "Forecast IVU from selected worklist rows"
    tipMap[hTipOcr]   := "Forecast from pasted text (PowerScribe)"
    tipMap[hTipHome]  := "Snap widget to bottom-right of rightmost monitor"
    tipMap[hTipReset] := "Reset the current timer"
    tipMap[hTipPar]   := "Click to set this study's par (or scroll over the widget)"
    tipMap[hTipPar2]  := "Click to set this study's par (or scroll over the widget)"

    ; Drag the widget by clicking anywhere on its body. Position reset is the
    ; explicit button in the action cluster - not a hidden gesture.

    ; --- Show ---
    Gui, Main:Show, x%posX% y%posY% w%GUI_W% h%GUI_H% NoActivate, RadTempo
    WinSet, Region, 0-0 w%GUI_W% h%GUI_H% R10-10, ahk_id %MainHwnd%

    ; Enable dragging by clicking anywhere on the widget
    OnMessage(0x201, "WM_LBUTTONDOWN")

    ; =============================================
    ;  Accent bar (3px bottom edge)
    ; =============================================
    barH := 3
    barY := posY + GUI_H - barH

    Gui, AccentBar:+AlwaysOnTop +ToolWindow -Caption +HwndAccentHwnd +Owner%MainHwnd%
    Gui, AccentBar:Color, %ACCENT_IDLE%
    Gui, AccentBar:Margin, 0, 0
    Gui, AccentBar:Show, x%posX% y%barY% w%GUI_W% h%barH% NoActivate, RadAccent

    SetTimer, SyncAccentBar, 200

    ; =============================================
    ;  Exam text banner (Option C - slim bar above widget)
    ;  Hidden by default, shown when exam text is captured
    ; =============================================
    bannerH := 18
    bannerY := posY - bannerH - 1

    Gui, ExamBanner:+AlwaysOnTop +ToolWindow -Caption +HwndBannerHwnd +Owner%MainHwnd%
    Gui, ExamBanner:Color, 141428
    Gui, ExamBanner:Margin, 0, 0
    Gui, ExamBanner:Font, s7 c5DCAA5 Normal, Segoe UI
    Gui, ExamBanner:Add, Text, vExamBannerText x8 y2 w180 h14, 
    Gui, ExamBanner:Font, s7 cAFA9EC Bold, Segoe UI
    Gui, ExamBanner:Add, Text, vExamBannerIVU x190 y2 w56 h14 Right, 
    ; Start hidden
    ; Gui, ExamBanner:Show  -- only shown when exam text is detected
}

SyncAccentBar:
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    if (mx != "" && my != "") {
        barY := my + GUI_H - 3
        WinMove, ahk_id %AccentHwnd%,, %mx%, %barY%
        ; Also sync exam banner position (above widget)
        bannerY := my - 19
        WinMove, ahk_id %BannerHwnd%,, %mx%, %bannerY%
    }
return

; Determine modality from exam text string (reliable fallback)
ModFromExamText(examText) {
    StringUpper, t, examText

    ; PET - most specific first
    if (InStr(t, "PET/CT") || InStr(t, "NM PET") || RegExMatch(t, "^\s*PET\b"))
        return "PET"

    ; MRI/MRA/MRCP - check before CT since "MRI" contains no CT ambiguity
    if (InStr(t, "MRI") || InStr(t, "MRCP") || RegExMatch(t, "^\s*MRA\b") || RegExMatch(t, "^\s*MR\b") || RegExMatch(t, "^\s*MRV\b"))
        return "MR"

    ; CTA/CTV/CT
    if (RegExMatch(t, "^\s*CTA\b") || RegExMatch(t, "^\s*CTV\b") || RegExMatch(t, "^\s*CT\b"))
        return "CT"

    ; Ultrasound
    if (RegExMatch(t, "^\s*US\b") || InStr(t, "ULTRASOUND") || InStr(t, "SONOGRAPH") || InStr(t, "DUPLEX"))
        return "US"

    ; X-ray / CR / Fluoro
    if (RegExMatch(t, "^\s*XR\b") || InStr(t, "X-RAY") || InStr(t, "FLUORO") || InStr(t, "BARIUM") || InStr(t, "HSG") || InStr(t, "DEXA") || InStr(t, "MAMMO"))
        return "CR"

    return ""
}

; Exam banner display functions
ShowExamBanner(examText) {
    global BannerHwnd, MainHwnd, GUI_W

    ; Truncate for display
    displayText := examText
    if (StrLen(displayText) > 35)
        displayText := SubStr(displayText, 1, 33) . ".."

    GuiControl, ExamBanner:, ExamBannerText, %displayText%

    ; Show banner positioned above widget
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    if (mx != "" && my != "") {
        bannerY := my - 19
        Gui, ExamBanner:Show, x%mx% y%bannerY% w%GUI_W% h18 NoActivate
    }
}

UpdateExamBannerIVU(ivuVal) {
    global
    if (ivuVal > 0) {
        ivuStr := Format("{:.2f}", ivuVal)
        ; A "~" marks a number that came from a weak description match
        ; rather than from PowerScribe or an exact code. The bug being
        ; fixed here is a guess that looked exactly like a measurement,
        ; so the guess has to look different.
        mark := IVUIsShaky() ? " ~" : ""
        GuiControl, ExamBanner:, ExamBannerIVU, IVU %ivuStr%%mark%
    } else {
        GuiControl, ExamBanner:, ExamBannerIVU,
    }
}

HideExamBanner() {
    Gui, ExamBanner:Hide
}

HideBannerTimer:
    HideExamBanner()
return

; ============================================================
;  WELLNESS BREAK PROMPTS
;  Shows after 90 min of continuous reading (no 30+ min gap)
; ============================================================

; Strain sampler. Runs every 5s for the whole session, independent of whether a
; study is open - strain does not pause because you happen to be between
; studies, and the old model's blind spot was exactly that.
WellnessTick() {
    global strainMs, wellLastTick, BREAK_MIN_MS, wellNextMs, WELL_SNOOZE_MS
    global lastBreakTime, breaksToday, breaksDate, wellCardOpen, wellCardDone

    now := A_TickCount
    if (!wellLastTick) {
        wellLastTick := now
        return
    }
    delta := now - wellLastTick
    wellLastTick := now
    if (delta <= 0)
        return
    ; A sleep/resume or a clock jump must not dump an hour into strain. Capping
    ; is safe in the honest direction: the idle check below credits the break.
    if (delta > 15000)
        delta := 15000

    if (A_TimeIdlePhysical >= BREAK_MIN_MS) {
        ; On a break. Only this clears strain.
        if (strainMs > 0) {
            CreditBreak()
            if (wellCardOpen)
                wellCardDone := true       ; the card sees this and celebrates
        }
        return
    }

    strainMs += delta
    if (strainMs >= wellNextMs && !wellCardOpen) {
        ; No break yet, so the next nudge is a snooze away rather than a full
        ; interval away - the reminder should not go quiet for another 90
        ; minutes just because you clicked it.
        wellNextMs := strainMs + WELL_SNOOZE_MS
        ShowWellnessCard("nudge")
    }
}

; The strain level the first nudge of a fresh cycle fires at.
StrainTarget() {
    global STREAK_LIMIT
    return STREAK_LIMIT
}

; Each prompt is "CATEGORY|Title|Body". The category drives the card's glyph and
; accent colour, so five hues cover thirty prompts - no colour is invented per
; prompt and the card reads as one thing rather than a random palette.
GetWellnessPrompts() {
    p := []
    p.Push("EYES|Look 20 feet away|Twenty seconds on something distant. The focus muscles unclench.")
    p.Push("MOVE|Stand and reach|Arms overhead, thirty seconds. Your spine has been waiting.")
    p.Push("NECK|Roll your shoulders|Ten backward, ten forward. Let the tension go somewhere else.")
    p.Push("WATER|Refill|Hydration is not optional equipment for an accurate read.")
    p.Push("NECK|Ear to shoulder|Slowly, each side, hold ten. Neck relief incoming.")
    p.Push("BREATHE|Five deep breaths|In for four, out for six. Eyes closed. Reset the room.")
    p.Push("MOVE|Ten calf raises|Gets the blood back up out of your legs.")
    p.Push("NECK|Squeeze the blades|Shoulder blades together, hold ten. Five times.")
    p.Push("MOVE|Wrist circles|Flex and extend, ten each way. Protect the hands you work with.")
    p.Push("EYES|Find a window|Thirty seconds of distance does more for your eyes than blinking.")
    p.Push("NECK|Sit tall|A string pulling up from the crown of your head. Hold that.")
    p.Push("MOVE|Push the palms out|Fingers interlocked, arms forward, fifteen seconds.")
    p.Push("NECK|Five chin tucks|Chin straight back, hold five. Undoes the screen lean.")
    p.Push("WATER|Water or tea|A hydrated radiologist is an accurate radiologist.")
    p.Push("MOVE|Open the chest|Hands behind your head, elbows wide, arch back gently. Breathe.")
    p.Push("EYES|Blink twenty times|Then close them for ten. Screen fatigue, undone.")
    p.Push("MOVE|March in place|Thirty seconds. Sitting still is the part that costs you.")
    p.Push("MOVE|Ankle circles|Ten each direction. Circulation does not manage itself.")
    p.Push("MOVE|Press the palms|Together at your chest, push ten seconds, release. Repeat.")
    p.Push("EYES|Up, down, left, right|Five times around. The eye muscles get a stretch too.")
    p.Push("EYES|Palm your eyes|Elbows on the desk, palms cupping closed eyes. Twenty seconds of dark.")
    p.Push("NECK|Twist in the chair|Left, then right, ten seconds each. Spinal reset.")
    p.Push("MOVE|Shake out your hands|Ten seconds, vigorously. Wiggle the fingers.")
    p.Push("MOVE|Two-minute walk|A lap of the reading room counts. Just move.")
    p.Push("NECK|Open the jaw|Wide, then closed, five times. You have been clenching.")
    p.Push("MOVE|Reach for your toes|Or near them. Fifteen seconds, then straighten slowly.")
    p.Push("NECK|Hand to shoulder|Right hand on left shoulder, look right, hold ten. Switch.")
    p.Push("BREATHE|Box breathing|In four, hold four, out four, hold four. Twice around.")
    p.Push("MOVE|Straighten a leg|Under the desk, hold ten, switch. Quiet quad work.")
    p.Push("BREATHE|You have earned this|That is a long stretch at the desk. Five minutes is cheap.")
    return p
}

; Glyph + accent for a prompt category. BMP code points only - Segoe UI Symbol
; is guaranteed to have these, where an astral emoji can land as a box.
WellCatGlyph(cat) {
    if (cat = "EYES")
        return Chr(0x25C9)     ; fisheye - an eye
    if (cat = "NECK")
        return Chr(0x21BB)     ; clockwise arrow - rotate
    if (cat = "WATER")
        return Chr(0x2248)     ; almost-equal - ripples
    if (cat = "BREATHE")
        return Chr(0x25CC)     ; dotted circle - a slow ring
    return Chr(0x21C5)         ; up-down arrows - move
}

WellCatColor(cat) {
    if (cat = "EYES")
        return "3987E5"
    if (cat = "NECK")
        return "9085E9"
    if (cat = "WATER")
        return "C98500"
    if (cat = "BREATHE")
        return "D55181"
    return "199E70"
}

WellCatName(cat) {
    if (cat = "EYES")
        return "EYES"
    if (cat = "NECK")
        return "NECK"
    if (cat = "WATER")
        return "HYDRATE"
    if (cat = "BREATHE")
        return "BREATHE"
    return "MOVE"
}

; --- Card timers and buttons (labels: the auto-execute section is above) ---
; Label names deliberately differ from the function names they call: a label
; and a function sharing a name is a trap AHK resolves silently.
WellStrainTimer:
    WellnessTick()
return

WellCardTimer:
    WellCardTick()
return

WellBtnA:
    ; nudge -> snooze; status or celebration -> just close
    if (wellCardMode = "nudge" && !wellCardDone)
        wellNextMs := strainMs + WELL_SNOOZE_MS
    HideWellnessCard()
return

WellBtnB:
    HideWellnessCard()
return

WellClose:
WellEscape:
    HideWellnessCard()
return

; ============================================================
;  THE REWARD BANK
;  Earnings are DERIVED from the log and the goals file, never stored - the
;  same rule every other number here follows, so a reward can't drift from the
;  work that produced it. Only cash-outs are persisted, because a withdrawal is
;  the one fact the log cannot reconstruct.
; ============================================================

; Points for one day. Pure arithmetic on four inputs, so the dashboard can
; compute exactly the same number from the CSV and the two can be compared.
RewardPoints(wins, bets, bestStreak, rungs) {
    global REWARD_RUNG_PTS, REWARD_STREAK_EVERY, REWARD_STREAK_BONUS
    parPts := wins
    if (REWARD_STREAK_EVERY > 0)
        parPts += REWARD_STREAK_BONUS * Floor(bestStreak / REWARD_STREAK_EVERY)
    goalPts := (rungs > 0) ? (REWARD_RUNG_PTS * rungs * (rungs + 1) / 2.0) : 0
    ; Focus scales what the volume was worth. Without this the two halves are
    ; just added, and a scattered day of high volume pays the same as a sharp
    ; one - which is the behaviour this is meant to move.
    winRate := (bets > 0) ? (wins / (bets + 0.0)) : 0
    focusMul := 0.75 + 0.5 * winRate
    return parPts + goalPts * focusMul
}

RewardDollars(pts) {
    global REWARD_PER_POINT
    return Round(pts * REWARD_PER_POINT * 100) / 100.0
}

; Today's live earning, from the counters the par scorer already keeps.
RewardTodayPoints() {
    global parWinsToday, parRunToday, parBestToday, todayIVU, todayGoal
    return RewardPoints(parWinsToday, parRunToday, parBestToday, GoalCredits(todayIVU))
}

; --- the cash-out ledger: Date,Amount,Note ---
LoadRewardLedger() {
    global REWARD_FILE, rewardCashed
    rewardCashed := 0.0
    if !FileExist(REWARD_FILE)
        return
    FileRead, rData, %REWARD_FILE%
    Loop, Parse, rData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        rp := StrSplit(A_LoopField, ",")
        if (rp.MaxIndex() < 2)
            continue
        rewardCashed += Trim(rp[2]) + 0.0
    }
}

AppendCashOut(amount, note) {
    global REWARD_FILE, rewardCashed
    if !FileExist(REWARD_FILE)
        FileAppend, Date,Amount,Note`n, %REWARD_FILE%
    FormatTime, cDate,, yyyy-MM-dd HH:mm
    StringReplace, note, note, `,, %A_Space%, All
    line := cDate . "," . Format("{:.2f}", amount) . "," . note . "`n"
    FileAppend, %line%, %REWARD_FILE%
    rewardCashed += amount
}

; Lifetime points across the whole log. Recomputed on demand rather than kept
; running, so a Clean Database or a fixed row is reflected immediately.
; Returns total DOLLARS earned, weekly cap applied per calendar week.
RewardEarnedTotal() {
    global LOG_FILE, REWARD_WEEK_CAP, REWARD_START
    if !FileExist(LOG_FILE)
        return 0.0
    ; Per date: bets, wins, best streak. Streak is per-day and in log order.
    dates := []
    winsBy := {}, betsBy := {}, bestBy := {}, runBy := {}, ivuBy := {}
    FileRead, rcsv, %LOG_FILE%
    Loop, Parse, rcsv, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        c := StrSplit(A_LoopField, ",")
        if (c.MaxIndex() < 10)
            continue
        dk := Trim(c[2])
        if (dk = "")
            continue
        if (REWARD_START != "" && StampOf(dk) < REWARD_START)
            continue                       ; before the bank opened
        if (!betsBy.HasKey(dk)) {
            dates.Push(dk)
            betsBy[dk] := 0, winsBy[dk] := 0, bestBy[dk] := 0, runBy[dk] := 0
            ivuBy[dk] := 0.0
        }
        ivuBy[dk] += Trim(c[10]) + 0.0
        parS := (c.MaxIndex() >= 14) ? Trim(c[14]) + 0 : 0
        actS := (c.MaxIndex() >= 13 && Trim(c[13]) != "") ? Trim(c[13]) + 0 : -1
        if (parS > 0 && actS >= 0) {
            betsBy[dk]++
            if (actS <= parS) {
                winsBy[dk]++
                runBy[dk]++
                if (runBy[dk] > bestBy[dk])
                    bestBy[dk] := runBy[dk]
            } else {
                runBy[dk] := 0
            }
        }
    }
    ; Sum per calendar week so the cap can be applied where it belongs.
    weekTot := {}
    total := 0.0
    for i, dk in dates {
        pts := RewardPoints(winsBy[dk], betsBy[dk], bestBy[dk], GoalCredits(ivuBy[dk]))
        amt := RewardDollars(pts)
        wk := WeekKeyOf(dk)
        prev := weekTot.HasKey(wk) ? weekTot[wk] : 0.0
        room := REWARD_WEEK_CAP - prev
        if (room <= 0)
            continue
        if (amt > room)
            amt := room
        weekTot[wk] := prev + amt
        total += amt
    }
    return Round(total * 100) / 100.0
}

; M/d/yyyy -> yyyyMMdd, so log dates can be compared as plain numbers.
StampOf(mdy) {
    p := StrSplit(mdy, "/")
    if (p.MaxIndex() < 3)
        return ""
    return Format("{:04}{:02}{:02}", p[3], p[1], p[2])
}

; "2026-W31" for an M/d/yyyy date - the bucket the weekly cap applies to.
WeekKeyOf(mdy) {
    p := StrSplit(mdy, "/")
    if (p.MaxIndex() < 3)
        return "?"
    stamp := Format("{:04}{:02}{:02}", p[3], p[1], p[2])
    FormatTime, wn, %stamp%, YWeek     ; e.g. 202631 - already unique per week
    return wn
}

RewardBalance() {
    global rewardCashed
    b := RewardEarnedTotal() - rewardCashed
    return (b < 0) ? 0 : Round(b * 100) / 100.0
}

; ============================================================
;  THE WELLNESS CARD
;  A real window, never a MsgBox. A modal box during dictation steals focus
;  from PowerScribe, which is not merely ugly - keystrokes land in the wrong
;  place. This carries WS_EX_NOACTIVATE (0x08000000), so it can appear and be
;  clicked without ever taking the foreground.
; ============================================================

; Sit above the widget on the widget's own monitor. Above, not centred, so it
; never covers the timer you are actually watching.
PlaceWellnessCard(w, h, ByRef px, ByRef py) {
    global MainHwnd
    px := ""
    py := ""
    WinGetPos, wx, wy, ww, wh, ahk_id %MainHwnd%
    if (wx = "")
        return false
    cx := wx + (ww // 2)
    cy := wy + (wh // 2)
    SysGet, monCount, MonitorCount
    Loop, %monCount% {
        SysGet, mon, MonitorWorkArea, %A_Index%
        if (cx >= monLeft && cx < monRight && cy >= monTop && cy < monBottom) {
            px := cx - (w // 2)
            py := wy - h - 26          ; clear of the exam banner that sits above
            if (py < monTop + 8)
                py := wy + wh + 12     ; no room above - drop below instead
            if (py + h > monBottom - 8)
                py := monBottom - h - 8
            if (px < monLeft + 8)
                px := monLeft + 8
            if (px + w > monRight - 8)
                px := monRight - w - 8
            return true
        }
    }
    return false
}

BuildWellnessCard() {
    ; ASSUME-GLOBAL, like BuildGUI(). Not a stylistic choice: every `v`-name on
    ; a Gui,Add inside a function must resolve to a global or static variable,
    ; so a function that adds controls has to be assume-global or AHK refuses to
    ; load with "A control's variable must be global or static". And per the
    ; mixing rule, an assume-global function must NOT also declare specific
    ; globals - that is a load-time error of its own.
    global

    Gui, Well:New, +AlwaysOnTop +ToolWindow -Caption +E0x08000000 +HwndWellHwnd +LabelWell
    Gui, Well:Color, %BG_MAIN%
    Gui, Well:Margin, 0, 0

    ; Top accent - recoloured per category, and it is also the strain readout
    Gui, Well:Add, Progress, vWellAccent x0 y0 w%wellCardW% h4 Background1C1C38 c3987E5 Range0-100, 100

    Gui, Well:Font, s20 Normal, Segoe UI Symbol
    Gui, Well:Add, Text, vWellIcon x16 y20 w40 h42 +Center +BackgroundTrans, % Chr(0x25C9)

    Gui, Well:Font, s7 c%TXT_LABEL% Bold, Segoe UI
    Gui, Well:Add, Text, vWellCat x62 y22 w270 h13 +BackgroundTrans,

    Gui, Well:Font, s12 c%TXT_RUN% Bold, Segoe UI
    Gui, Well:Add, Text, vWellTitle x62 y36 w272 h26 +BackgroundTrans,

    Gui, Well:Font, s9 c%TXT_COUNT% Normal, Segoe UI
    Gui, Well:Add, Text, vWellBody x16 y72 w316 h34 +BackgroundTrans,

    ; The break meter. This is the whole idea: the card does not ask you to
    ; confirm a break, it watches for one.
    Gui, Well:Add, Progress, vWellMeter x16 y114 w316 h6 Background1C1C38 c199E70 Range0-100, 0

    Gui, Well:Font, s8 c%TXT_LABEL% Normal, Segoe UI
    Gui, Well:Add, Text, vWellFoot x16 y126 w316 h16 +BackgroundTrans,

    Gui, Well:Font, s8 c%TXT_COUNT% Bold, Segoe UI
    Gui, Well:Add, Text, vWellA x16 y150 w154 h24 Background%SEG_BG% +Center gWellBtnA,
    Gui, Well:Add, Text, vWellB x178 y150 w154 h24 Background%SEG_BG% +Center gWellBtnB,
}

ShowWellnessCard(mode) {
    global wellCardOpen, wellCardAt, wellCardMode, wellCardDone, WellHwnd
    global wellCardW, wellCardH, wellnessIndex, strainMs, BREAK_MIN_MS
    global WELL_SNOOZE_MS, wellDoneAt

    if (!WellHwnd)
        BuildWellnessCard()

    wellCardMode := mode
    wellCardDone := false
    wellDoneAt := 0
    wellCardAt := A_TickCount

    if (mode = "nudge") {
        prompts := GetWellnessPrompts()
        wellnessIndex++
        if (wellnessIndex > prompts.MaxIndex())
            wellnessIndex := 1
        parts := StrSplit(prompts[wellnessIndex], "|")
        cat := parts[1]
        col := WellCatColor(cat)
        GuiControl, Well:, WellIcon, % WellCatGlyph(cat)
        iconOpt := "Well:+c" . col
        GuiControl, % iconOpt, WellIcon
        GuiControl, Well:, WellCat, % WellCatName(cat) . "   " . Chr(0x2022) . "   "
                                    . Round(strainMs / 60000) . " MIN AT THE DESK"
        GuiControl, Well:, WellTitle, % parts[2]
        GuiControl, Well:, WellBody, % parts[3]
        accOpt := "Well:+c" . col
        GuiControl, % accOpt, WellAccent
        GuiControl, Well:, WellAccent, 100
        GuiControl, Well:, WellA, % "Snooze " . (WELL_SNOOZE_MS // 60000) . " min"
        GuiControl, Well:, WellB, Dismiss
        GuiControl, Well:Move, WellA, x16 w154
        GuiControl, Well:Show, WellB
        SoundPlay, *64
    } else {
        GuiControl, Well:, WellIcon, % Chr(0x25D4)
        GuiControl, Well:+c3987E5, WellIcon
        GuiControl, Well:, WellCat, WELLNESS
        GuiControl, Well:+c3987E5, WellAccent
        WellFillStatus()
        ; No "log a break" button on purpose. Strain is measured, not asserted -
        ; a button that clears it is the same mistake as a goal that becomes a
        ; ceiling. Tray > Wellness > Reset Strain is there if it is ever needed.
        GuiControl, Well:, WellA, Close
        GuiControl, Well:Move, WellA, x16 w316
        GuiControl, Well:Hide, WellB
    }

    WellUpdateMeter()
    PlaceWellnessCard(wellCardW, wellCardH, cx2, cy2)
    if (cx2 = "")
        Gui, Well:Show, w%wellCardW% h%wellCardH% NoActivate, RadWellness
    else
        Gui, Well:Show, x%cx2% y%cy2% w%wellCardW% h%wellCardH% NoActivate, RadWellness
    WinSet, Region, 0-0 w%wellCardW% h%wellCardH% R12-12, ahk_id %WellHwnd%
    wellCardOpen := true
    SetTimer, WellCardTimer, 250
}

; Status flavour of the same card - so there is one wellness surface, not a
; pretty notification and an ugly text dump behind a menu item.
WellFillStatus() {
    global strainMs, STREAK_LIMIT, lastBreakTime, breaksToday, BREAK_MIN_MS
    mins := Round(strainMs / 60000)
    left := Round((STREAK_LIMIT - strainMs) / 60000)
    if (left < 0)
        left := 0
    GuiControl, Well:, WellTitle, % mins . " min at the desk"
    ; Written out rather than as a wrapped ternary: AHK v1 continuation lines
    ; starting with ":" are ambiguous with a label and not worth the risk.
    if (strainMs >= STREAK_LIMIT)
        body := "You are past the " . (STREAK_LIMIT // 60000) . "-minute mark. A break is due."
    else
        body := left . " min of desk time until the next nudge."
    body .= "  Last break " . (lastBreakTime != "" ? lastBreakTime : "not yet today")
          . ", " . breaksToday . " today."
    GuiControl, Well:, WellBody, % body
    pct := (STREAK_LIMIT > 0) ? Round(strainMs / STREAK_LIMIT * 100) : 0
    if (pct > 100)
        pct := 100
    GuiControl, Well:, WellAccent, %pct%
}

; Fill the meter from how long you have actually been away. One rule, measured
; one way and shown one way: a break is BREAK_MIN_MS of physical absence.
WellUpdateMeter() {
    global BREAK_MIN_MS, wellCardDone, wellCardMode
    if (wellCardDone) {
        GuiControl, Well:, WellMeter, 100
        return
    }
    idle := A_TimeIdlePhysical
    pct := Round(idle / BREAK_MIN_MS * 100)
    if (pct > 100)
        pct := 100
    GuiControl, Well:, WellMeter, %pct%
    secs := Round(idle / 1000)
    need := Round(BREAK_MIN_MS / 1000)
    if (wellCardMode = "status")
        GuiControl, Well:, WellFoot, % "Away " . FormatSeconds(secs) . " of "
                                     . FormatSeconds(need) . " - stay away and the strain clears."
    else
        GuiControl, Well:, WellFoot, % "Step away for " . FormatSeconds(need)
                                     . " and this clears itself. " . FormatSeconds(secs) . " so far."
}

WellCardTick() {
    global wellCardOpen, wellCardAt, wellCardDone, wellDoneAt
    global WELL_CARD_MS, wellCardMode, BREAK_MIN_MS, breaksToday

    if (!wellCardOpen)
        return

    if (wellCardDone) {
        ; The strain sampler verified a real break while this card was up. Say
        ; so, then get out of the way - nothing to click, nothing to confirm.
        if (!wellDoneAt) {
            wellDoneAt := A_TickCount
            GuiControl, Well:, WellIcon, % Chr(0x2713)
            GuiControl, Well:+c0CA30C, WellIcon
            GuiControl, Well:+c0CA30C, WellAccent
            GuiControl, Well:, WellAccent, 100
            GuiControl, Well:, WellCat, BREAK LOGGED
            GuiControl, Well:, WellTitle, Strain cleared
            GuiControl, Well:, WellBody, % "That counted - break " . breaksToday
                                         . " today. The clock starts again from zero."
            GuiControl, Well:, WellMeter, 100
            GuiControl, Well:, WellFoot,
            GuiControl, Well:, WellA, Nice
            GuiControl, Well:Move, WellA, x16 w316
            GuiControl, Well:Hide, WellB
        }
        if (A_TickCount - wellDoneAt > 5000)
            HideWellnessCard()
        return
    }

    WellUpdateMeter()
    if (wellCardMode = "status")
        WellFillStatus()

    ; Auto-hide only once you are demonstrably back at the desk and ignoring it.
    ; Hiding on a fixed timer would close the card mid-break, right before the
    ; break it is waiting for completes. The absolute cap is the backstop.
    age := A_TickCount - wellCardAt
    if (age > WELL_CARD_MS && A_TimeIdlePhysical < 5000)
        HideWellnessCard()
    else if (age > BREAK_MIN_MS + 600000)
        HideWellnessCard()
}

HideWellnessCard() {
    global wellCardOpen
    SetTimer, WellCardTimer, Off
    Gui, Well:Hide
    wellCardOpen := false
}

; Change the nudge interval. Re-aims the pending nudge at the new level rather
; than leaving it at the old one, so switching 90 -> 60 while already at 70 min
; fires now instead of at 105.
SetWellnessInterval(mins) {
    global wellnessMinutes, STREAK_LIMIT, wellNextMs, strainMs
    wellnessMinutes := mins
    STREAK_LIMIT := mins * 60000
    wellNextMs := STREAK_LIMIT
    SaveSetting("WellnessMinutes", mins)
    Menu, WellnessMenu, % (mins = 60) ? "Check" : "Uncheck", Set to 60 min
    Menu, WellnessMenu, % (mins = 90) ? "Check" : "Uncheck", Set to 90 min
    NotifyAtWidget("Break nudge at " . mins . " min of desk time."
                 . "`nYou are at " . Round(strainMs / 60000) . " min now.")
}

; Credit a break without waiting for one - used by Reset Strain, and by the
; "already on a break" path so the counters stay consistent in one place.
CreditBreak() {
    global strainMs, wellNextMs, lastBreakTime, breaksToday, breaksDate
    strainMs := 0
    wellNextMs := StrainTarget()
    FormatTime, lastBreakTime,, h:mm tt
    FormatTime, bToday,, yyyy-MM-dd
    if (breaksDate != bToday) {
        breaksDate := bToday
        breaksToday := 0
    }
    breaksToday++
}

; Drag handler - allows moving the widget by clicking on empty space
; Park the widget at the bottom-right of the RIGHTMOST monitor.
; Reachable three ways: double-click the widget, tray > Snap to Corner, and
; the tray tip. Kept as a function (not just a label) because OnMessage
; handlers can not GoSub a global label safely.
SnapToCorner() {
    global GUI_W, GUI_H, MainHwnd, INI_FILE, lastSavedPosX, lastSavedPosY
    SysGet, monCount, MonitorCount
    maxRight := -999999
    bestBottom := 0
    Loop, %monCount% {
        SysGet, mon, Monitor, %A_Index%
        if (monRight > maxRight) {
            maxRight   := monRight
            bestBottom := monBottom
        }
    }
    posX := maxRight   - GUI_W - 20
    posY := bestBottom - GUI_H - 55
    WinMove, ahk_id %MainHwnd%,, %posX%, %posY%
    IniWrite, %posX%, %INI_FILE%, Window, PosX
    IniWrite, %posY%, %INI_FILE%, Window, PosY
    lastSavedPosX := posX
    lastSavedPosY := posY
    ; Accent bar follows via the SyncAccentBar timer
}

; Click anywhere on the widget body to drag it. Deliberately NOT a
; double-click-to-snap surface: that gesture was invisible, and an accidental
; double-click while repositioning would teleport the widget. Position reset
; is the explicit button instead.
WM_LBUTTONDOWN(wParam, lParam, msg, hwnd) {
    global MainHwnd
    if (hwnd = MainHwnd) {
        PostMessage, 0xA1, 2,,, ahk_id %MainHwnd%  ; WM_NCLBUTTONDOWN, HTCAPTION
    }
}

; ============================================================
;  SET PAR - click the PAR slot on the widget
;  Adjustments are relative to the suggested par, so "Suggested"
;  always gets you back to your own median for this exam type.
; ============================================================
ParClick:
    if (!timerRunning) {
        ; not mid-study: the slot is showing today's exam count
        return
    }
    Gui, ParDlg:Destroy
    Gui, ParDlg:+AlwaysOnTop +ToolWindow +HwndParDlgHwnd +LabelParDlg
    Gui, ParDlg:Color, 0F0F24
    Gui, ParDlg:Margin, 0, 0

    Gui, ParDlg:Add, Text, x0 y0 w310 h3 +Background3987E5

    Gui, ParDlg:Font, s8 c7A7A99 Normal, Segoe UI
    Gui, ParDlg:Add, Text, x16 y14 w278 h14 +BackgroundTrans, % (lastExamText != "") ? lastExamText : "exam not detected yet"

    Gui, ParDlg:Font, s22 cFFFFFF Bold, Segoe UI
    Gui, ParDlg:Add, Text, vParDlgVal x16 y32 w150 h36 +BackgroundTrans, % (parSec > 0) ? FormatSeconds(Round(parSec)) : "--:--"

    Gui, ParDlg:Font, s8 c7A7A99 Normal, Segoe UI
    Gui, ParDlg:Add, Text, vParDlgSug x16 y70 w278 h14 +BackgroundTrans, % "suggested " . ((parBase > 0) ? FormatSeconds(Round(parBase)) : "--")

    Gui, ParDlg:Font, s9 Normal, Segoe UI
    Gui, ParDlg:Add, Button, x16  y94 w54 h28 gParM60, % Chr(0x2212) . "1:00"
    Gui, ParDlg:Add, Button, x74  y94 w54 h28 gParM15, % Chr(0x2212) . "0:15"
    Gui, ParDlg:Add, Button, x132 y94 w62 h28 gParSuggested, Suggested
    Gui, ParDlg:Add, Button, x198 y94 w54 h28 gParP15, +0:15
    Gui, ParDlg:Add, Button, x256 y94 w54 h28 gParP60, +1:00

    Gui, ParDlg:Add, Button, x16 y130 w294 h30 gParDlgDone, Done
    parDlgOpen := true
    if (GetWidgetMonitorPos(326, 176, pdx, pdy))
        Gui, ParDlg:Show, x%pdx% y%pdy% w326 h176, Set par
    else
        Gui, ParDlg:Show, w326 h176, Set par
    UpdateCountArea()
return

ParM60:
    ParShift(-60)
return
ParM15:
    ParShift(-15)
return
ParP15:
    ParShift(15)
return
ParP60:
    ParShift(60)
return

; Back to your own median for this exam type
ParSuggested:
    if (parBase > 0) {
        parAdjust := 0
        parSec := parBase
        UpdateCountArea()
        UpdateActivityUI()
    }
return

ParDlgDone:
ParDlgClose:
ParDlgEscape:
    parDlgOpen := false
    Gui, ParDlg:Destroy
return

; Right-click anywhere on the widget - including on its buttons - opens the
; same menu as the tray icon. Fired by AHK because the GUI carries +LabelMain.
MainContextMenu:
    Menu, Tray, Show
return

; Position-reset button
DoSnapHome:
    SnapToCorner()
return

; ------------------------------------------------------------
;  Hover tooltips for the action buttons. The glyphs are compact
;  by necessity, so the label has to come from hovering rather
;  than from guessing what a symbol means.
; ------------------------------------------------------------
TipCheck:
    MouseGetPos,,,, tipCtrlHwnd, 2
    if (tipCtrlHwnd != "" && tipMap.HasKey(tipCtrlHwnd)) {
        if (tipCtrlHwnd != tipLastHwnd) {
            tipLastHwnd := tipCtrlHwnd
            ToolTip, % tipMap[tipCtrlHwnd]
            SetTimer, TipClear, -4000
        }
    } else if (tipLastHwnd != 0) {
        tipLastHwnd := 0
        ToolTip
    }
return

TipClear:
    ToolTip
return

; ============================================================
;  IVU BREAKDOWN POPUP - click on IVU number to see per-modality
; ============================================================

ShowIVUBreakdown:
    ; Position near widget
    WinGetPos, mx, my,,, ahk_id %MainHwnd%
    bx := mx
    by := my - 130

    Gui, IVUPop:Destroy
    Gui, IVUPop:+AlwaysOnTop +ToolWindow -Caption +Owner%MainHwnd%
    Gui, IVUPop:Color, 141428
    Gui, IVUPop:Margin, 12, 8

    Gui, IVUPop:Font, s9 cAFA9EC Bold, Segoe UI
    Gui, IVUPop:Add, Text, x12 y8 w130 h16, IVU Breakdown - Today

    yy := 28
    Gui, IVUPop:Font, s8 c5DCAA5 Normal, Segoe UI
    crVal := Format("{:.1f}", todayIVU_CR)
    Gui, IVUPop:Add, Text, x12 y%yy% w130 h14, CR (X-Ray): %crVal%

    yy += 16
    Gui, IVUPop:Font, s8 cE8D44D Normal, Segoe UI
    ctVal := Format("{:.1f}", todayIVU_CT)
    Gui, IVUPop:Add, Text, x12 y%yy% w130 h14, CT: %ctVal%

    yy += 16
    Gui, IVUPop:Font, s8 c85B7EB Normal, Segoe UI
    mrVal := Format("{:.1f}", todayIVU_MR)
    Gui, IVUPop:Add, Text, x12 y%yy% w130 h14, MR: %mrVal%

    yy += 16
    Gui, IVUPop:Font, s8 cED93B1 Normal, Segoe UI
    usVal := Format("{:.1f}", todayIVU_US)
    Gui, IVUPop:Add, Text, x12 y%yy% w130 h14, US: %usVal%

    yy += 16
    Gui, IVUPop:Font, s8 cAFA9EC Normal, Segoe UI
    petVal := Format("{:.1f}", todayIVU_PET)
    Gui, IVUPop:Add, Text, x12 y%yy% w130 h14, PET: %petVal%

    yy += 20
    Gui, IVUPop:Font, s9 cFFFFFF Bold, Segoe UI
    totalVal := Format("{:.1f}", todayIVU)
    Gui, IVUPop:Add, Text, x12 y%yy% w150 h16, Total: %totalVal%

    ; Block context: typical for the block active right now + pace
    UpdateCurrentBlock()
    popTypN := 0
    popTyp := GetShiftTypical(currentBlock, popTypN)
    if (popTyp > 0 && popTypN >= 2) {
        yy += 20
        Gui, IVUPop:Font, s7 c555577 Normal, Segoe UI
        shDisp := (currentBlock != "") ? currentBlock : "any block"
        if (currentExtras != "")
            shDisp .= "  +mods"
        if (StrLen(shDisp) > 24)
            shDisp := SubStr(shDisp, 1, 22) . ".."
        Gui, IVUPop:Add, Text, x12 y%yy% w150 h12, %shDisp%
        yy += 14
        blkNow := GetTodayBlockIVU(currentBlock)
        typV := Format("{:.1f}", popTyp)
        blkV := Format("{:.1f}", blkNow)
        Gui, IVUPop:Add, Text, x12 y%yy% w150 h12, Block: %blkV% / typ %typV% (n=%popTypN%)
        yy += 14
        pc := Round((blkNow / popTyp) * 100)
        pcCol := (pc >= 100) ? "5DCAA5" : ((pc >= 70) ? "E8D44D" : "ED93B1")
        Gui, IVUPop:Font, s8 c%pcCol% Bold, Segoe UI
        Gui, IVUPop:Add, Text, x12 y%yy% w150 h14, Block pace: %pc%`%
    }

    ; Today's time, priced. Engaged hours are what your rate actually buys;
    ; the idle line is the part worth shrinking. Never a per-study figure.
    if (HOURLY_RATE > 0) {
        yy += 18
        engSecToday := GetTodayEngagedSec()
        idleSecToday := GetTodayIdleSec()
        engStr := "$" . Format("{:.0f}", engSecToday / 3600.0 * HOURLY_RATE)
        idleStr := "$" . Format("{:.0f}", idleSecToday / 3600.0 * HOURLY_RATE)
        Gui, IVUPop:Font, s8 c7A7A99 Normal, Segoe UI
        Gui, IVUPop:Add, Text, x12 y%yy% w150 h12, % "Engaged today: " . engStr
        yy += 14
        idleCol2 := (idleSecToday >= 900) ? "ED93B1" : "7A7A99"
        Gui, IVUPop:Font, s8 c%idleCol2% Normal, Segoe UI
        Gui, IVUPop:Add, Text, x12 y%yy% w150 h12, % "Idle today: " . idleStr
    }

    popH := yy + 24
    Gui, IVUPop:Show, x%bx% y%by% w174 h%popH% NoActivate, IVUBreakdown

    ; Auto-close after 8 seconds
    SetTimer, CloseIVUPop, -8000
return

CloseIVUPop:
    Gui, IVUPop:Destroy
return

IVUPopGuiClose:
    Gui, IVUPop:Destroy
return

; ============================================================
;  HELPERS
; ============================================================

; The widget's big clock only. TimeDisplay is 112px at s21 Bold, which fits
; seven glyphs - "9:59:59" just makes it, "46:32:28" does not, and AHK does not
; wrap or ellipsize a Text control, it silently clips. A clipped "46:32:2" is
; worse than useless: it reads as a real time and is wrong by ten hours.
; Past ten hours the seconds are noise anyway, so they go instead of a digit.
FormatClock(totalSec) {
    if (totalSec >= 36000)
        return Format("{:d}h{:02d}", totalSec // 3600, Mod(totalSec, 3600) // 60)
    return FormatSeconds(totalSec)
}

FormatSeconds(totalSec) {
    h := totalSec // 3600
    m := Mod(totalSec, 3600) // 60
    s := Mod(totalSec, 60)
    if (h > 0)
        return Format("{:d}:{:02d}:{:02d}", h, m, s)
    return Format("{:02d}:{:02d}", m, s)
}

; ============================================================
;  CSV LOGGING
; ============================================================

LogTime(elapsedSec, modality, examText:="", ivu:=0.00, activeSec:=-1, parTarget:=0, procCode:="", ivuSrc:="") {
    global LOG_FILE, studyCount, todayCount, pendingWrites
    FormatTime, now,, M/d/yyyy H:mm
    FormatTime, dateOnly,, M/d/yyyy
    FormatTime, hourOnly,, HH
    FormatTime, dayName,, ddd
    friendly := FormatSeconds(elapsedSec)

    ; Clean exam text for CSV (remove commas, quotes, newlines)
    StringReplace, examClean, examText, ",", , All
    StringReplace, examClean, examClean, `n, , All
    StringReplace, examClean, examClean, `r, , All

    ; Format IVU to 2 decimal places
    ivuStr := Format("{:.2f}", ivu)

    ; Create header if file doesn't exist
    if !FileExist(LOG_FILE) {
        FileAppend, Timestamp`,Date`,DayOfWeek`,Hour`,Seconds`,Formatted`,Modality`,DailyStudyNum`,ExamText`,IVU`,Shift`,Extras`,ActiveSec`,ParSec`,ProcCode`,IVUSrc`n, %LOG_FILE%
        if (ErrorLevel) {
            LOG_FILE := A_MyDocuments . "\RadTempo_Log.csv"
            FileAppend, Timestamp`,Date`,DayOfWeek`,Hour`,Seconds`,Formatted`,Modality`,DailyStudyNum`,ExamText`,IVU`,Shift`,Extras`,ActiveSec`,ParSec`,ProcCode`,IVUSrc`n, %LOG_FILE%
        }
    }

    ; Attribute this sign to the primary block active right now,
    ; plus any concurrent modifiers (POC, Readout, Conf...)
    shiftStr := "", extrasStr := ""
    AttributeMoment(dateOnly, A_Hour + (A_Min / 60.0), shiftStr, extrasStr)

    actStr := (activeSec >= 0) ? activeSec : ""
    parStr := (parTarget > 0) ? parTarget : ""
    ; ProcCode is an exam-type code, not a patient identifier - the
    ; accession that sits next to it in PowerScribe is deliberately NOT
    ; carried here. IVUSrc records whether the IVU was PowerScribe's own
    ; number, a table code hit, or a fuzzy guess and how good it was.
    StringReplace, codeClean, procCode, `,, , All
    StringReplace, srcClean, ivuSrc, `,, , All
    line := now . "," . dateOnly . "," . dayName . "," . hourOnly . "," . elapsedSec . "," . friendly . "," . modality . "," . todayCount . "," . examClean . "," . ivuStr . "," . shiftStr . "," . extrasStr . "," . actStr . "," . parStr . "," . codeClean . "," . srcClean

    ; Try to flush any pending writes first
    if (pendingWrites != "") {
        FileAppend, %pendingWrites%, %LOG_FILE%
        if (!ErrorLevel)
            pendingWrites := ""
    }

    ; Write current line
    FileAppend, %line%`n, %LOG_FILE%

    ivuDisp := (ivu > 0) ? " IVU:" . ivuStr : ""
    global lastNumExams
    exDisp := (lastNumExams > 1) ? " (" . lastNumExams . " exams)" : ""

    if (ErrorLevel) {
        ; File is locked - queue this write for later
        pendingWrites .= line . "`n"
        queued := StrSplit(pendingWrites, "`n").MaxIndex() - 1
        ToolTip, % "FILE LOCKED - " . queued . " queued | " . modality . " " . friendly . ivuDisp, 0, 0
    } else {
        ToolTip, %modality% %friendly%%ivuDisp%%exDisp% logged (#%todayCount%), 0, 0
    }

    SetTimer, ClearToolTip, -3000
}

; Periodically try to flush pending writes
; (SetTimer, FlushPending is in the auto-execute section at the top)

FlushPending:
    if (pendingWrites != "") {
        FileAppend, %pendingWrites%, %LOG_FILE%
        if (!ErrorLevel) {
            flushed := StrSplit(pendingWrites, "`n").MaxIndex() - 1
            pendingWrites := ""
            ToolTip, % flushed . " queued studies written to log", 0, 0
            SetTimer, ClearToolTip, -2000
        }
    }
return

ClearToolTip:
    ToolTip
return

; --- Count today's studies from existing CSV ---
InitTodayCount() {
    global LOG_FILE, todayCount, studyCount
    global todayIVU, todayIVU_CR, todayIVU_CT, todayIVU_MR, todayIVU_US, todayIVU_PET
    todayCount := 0
    studyCount := 0
    todayIVU := 0.00
    todayIVU_CR := 0.00
    todayIVU_CT := 0.00
    todayIVU_MR := 0.00
    todayIVU_US := 0.00
    todayIVU_PET := 0.00

    if !FileExist(LOG_FILE)
        return

    FormatTime, today,, M/d/yyyy
    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1)
            continue
        if (A_LoopField = "")
            continue
        studyCount++
        if InStr(A_LoopField, today) {
            todayCount++
            ; Parse IVU and modality from this row
            parts := StrSplit(A_LoopField, ",")
            mod := parts[7]
            ivu := (parts.MaxIndex() >= 10) ? parts[10] + 0.0 : 0.0
            todayIVU += ivu
            if (mod = "CR")
                todayIVU_CR += ivu
            else if (mod = "CT")
                todayIVU_CT += ivu
            else if (mod = "MR")
                todayIVU_MR += ivu
            else if (mod = "US")
                todayIVU_US += ivu
            else if (mod = "PET")
                todayIVU_PET += ivu
        }
    }

    ; PowerScribe's own figure for the day, if one has been entered. It is
    ; the authoritative total, so it replaces ours rather than sitting
    ; beside it - that is the entire point of typing it in. The per-modality
    ; split stays as logged; only the total is corrected.
    todayIVU += TodayAdjust()
    if (todayIVU < 0)
        todayIVU := 0
}

; ============================================================
;  SPEED WARNING - per-study-type average times
;  Computes the average reading time for each exam type and
;  each modality from the CSV history. Used to flash a warning
;  when the current study runs past WARN_PCT% of its average.
; ============================================================

; Numeric median of a newline-delimited list. Median rather than mean because
; read times are right-skewed - a single 40-minute study drags a mean well
; above the typical case and would make par far too generous.
MedianOf(listStr) {
    if (listStr = "")
        return 0
    Sort, listStr, N
    arr := StrSplit(listStr, "`n")
    n := arr.MaxIndex()
    if (!n)
        return 0
    if (Mod(n, 2) = 1)
        return arr[(n + 1) // 2] + 0
    return (arr[n // 2] + arr[n // 2 + 1]) / 2.0
}

; Build per-exam and per-modality PAR values.
; Par is measured in ENGAGED seconds (CSV col 13, ActiveSec) so the bet is
; against losing focus, never against reading carefully. ActiveSec only
; started being logged recently, so until an exam type has enough engaged
; samples we fall back to its elapsed-time median and flag it provisional -
; that par is generous, which is the right way to start.
LoadExamAverages() {
    global LOG_FILE, examParMap, modParMap, PAR_MIN_SAMPLES

    examParMap := {}
    modParMap := {}
    if !FileExist(LOG_FILE)
        return

    examAct := {}, examEl := {}
    modAct := {}, modEl := {}

    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1)
            continue
        if (A_LoopField = "")
            continue
        parts := StrSplit(A_LoopField, ",")
        if (parts.MaxIndex() < 7)
            continue
        secs := Trim(parts[5]) + 0
        mod := Trim(parts[7])
        exam := (parts.MaxIndex() >= 9) ? Trim(parts[9]) : ""
        act := (parts.MaxIndex() >= 13) ? Trim(parts[13]) + 0 : 0

        ; Skip obviously bad rows (the outlier cleanup removes most, but be safe)
        if (secs < 15)
            continue

        if (exam != "") {
            examEl[exam] := (examEl.HasKey(exam) ? examEl[exam] . "`n" : "") . secs
            if (act > 0)
                examAct[exam] := (examAct.HasKey(exam) ? examAct[exam] . "`n" : "") . act
        }
        if (mod != "") {
            modEl[mod] := (modEl.HasKey(mod) ? modEl[mod] . "`n" : "") . secs
            if (act > 0)
                modAct[mod] := (modAct.HasKey(mod) ? modAct[mod] . "`n" : "") . act
        }
    }

    ; Per-exam par: engaged median when we have enough of it, else elapsed
    for exam, elList in examEl {
        nEl := StrSplit(elList, "`n").MaxIndex()
        actList := examAct.HasKey(exam) ? examAct[exam] : ""
        nAct := (actList = "") ? 0 : StrSplit(actList, "`n").MaxIndex()
        if (nAct >= PAR_MIN_SAMPLES)
            examParMap[exam] := MedianOf(actList)
        else if (nEl >= PAR_MIN_SAMPLES)
            examParMap[exam] := MedianOf(elList)
    }
    ; Per-modality fallback - always compute, any sample count
    for mod, elList in modEl {
        actList := modAct.HasKey(mod) ? modAct[mod] : ""
        nAct := (actList = "") ? 0 : StrSplit(actList, "`n").MaxIndex()
        if (nAct >= PAR_MIN_SAMPLES)
            modParMap[mod] := MedianOf(actList)
        else
            modParMap[mod] := MedianOf(elList)
    }
}

; Sum of engaged seconds logged today (CSV col 13).
GetTodayEngagedSec() {
    global LOG_FILE
    FormatTime, tdy,, M/d/yyyy
    tot := 0
    if !FileExist(LOG_FILE)
        return 0
    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 13)
            continue
        if (Trim(p[2]) != tdy)
            continue
        tot += Trim(p[13]) + 0
    }
    return tot
}

; Idle seconds inside today's studies: elapsed minus engaged, per study.
GetTodayIdleSec() {
    global LOG_FILE
    FormatTime, tdy,, M/d/yyyy
    tot := 0
    if !FileExist(LOG_FILE)
        return 0
    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 13)
            continue
        if (Trim(p[2]) != tdy)
            continue
        el := Trim(p[5]) + 0
        ac := Trim(p[13]) + 0
        if (ac > 0 && el > ac)
            tot += (el - ac)
    }
    return tot
}

; ============================================================
;  POPUP PLACEMENT
;  AHK centres dialogs on the primary display. On a four-monitor
;  workstation with the widget parked bottom-right of the RIGHTMOST
;  screen, that throws every prompt onto a different monitor than
;  the thing you just clicked. These put popups where the widget is.
; ============================================================

; Top-left for a w x h popup, centred on the widget and clamped to the work
; area of the monitor the widget actually sits on. Returns false if the widget
; position can't be read, in which case callers fall back to AHK's default.
GetWidgetMonitorPos(w, h, ByRef px, ByRef py) {
    global MainHwnd
    px := ""
    py := ""
    WinGetPos, wx, wy, ww, wh, ahk_id %MainHwnd%
    if (wx = "")
        return false
    cx := wx + (ww // 2)
    cy := wy + (wh // 2)
    SysGet, monCount, MonitorCount
    Loop, %monCount% {
        SysGet, mon, MonitorWorkArea, %A_Index%
        if (cx >= monLeft && cx < monRight && cy >= monTop && cy < monBottom) {
            px := cx - (w // 2)
            py := cy - (h // 2)
            if (px < monLeft)
                px := monLeft + 8
            if (py < monTop)
                py := monTop + 8
            if (px + w > monRight)
                px := monRight - w - 8
            if (py + h > monBottom)
                py := monBottom - h - 8
            return true
        }
    }
    return false
}

; Brief confirmation next to the widget. Replaces MsgBox for goal feedback:
; a MsgBox can't be positioned without hooking WM_ACTIVATE, and a modal box is
; heavier than this needs to be anyway.
NotifyAtWidget(txt) {
    global MainHwnd
    CoordMode, ToolTip, Screen        ; thread-local, resets when this thread ends
    WinGetPos, wx, wy,, wh, ahk_id %MainHwnd%
    if (wx = "")
        ToolTip, %txt%
    else
        ToolTip, %txt%, % wx, % wy - 34
    SetTimer, ClearToolTip, -2600
}

; ============================================================
;  DAILY IVU GOAL
; ============================================================
LoadGoals() {
    global GOALS_FILE, goalByDate, todayGoal
    goalByDate := {}
    if FileExist(GOALS_FILE) {
        FileRead, gData, %GOALS_FILE%
        Loop, Parse, gData, `n, `r
        {
            if (A_Index = 1 || A_LoopField = "")
                continue
            gp := StrSplit(A_LoopField, ",")
            if (gp.MaxIndex() < 2)
                continue
            gk := Trim(gp[1])
            gv := Trim(gp[2]) + 0
            if (gk != "" && gv > 0)
                goalByDate[gk] := gv
        }
    }
    FormatTime, gToday,, M/d/yyyy
    todayGoal := goalByDate.HasKey(gToday) ? goalByDate[gToday] : 0
}

SaveGoal(dateStr, val) {
    global GOALS_FILE, goalByDate, todayGoal
    if (val > 0)
        goalByDate[dateStr] := val
    else
        goalByDate.Delete(dateStr)
    out := "Date,GoalIVU`n"
    for gk, gv in goalByDate
        out .= gk . "," . gv . "`n"
    FileDelete, %GOALS_FILE%
    FileAppend, %out%, %GOALS_FILE%
    FormatTime, gToday,, M/d/yyyy
    todayGoal := goalByDate.HasKey(gToday) ? goalByDate[gToday] : 0
    UpdateGoalUI()
}

; Median IVU across worked days - the honest "a normal day for me" number,
; used to seed goal presets. Median not mean: a couple of monster days would
; drag a mean up and make every preset feel unreachable.
TypicalDailyIVU() {
    global LOG_FILE
    if !FileExist(LOG_FILE)
        return 0
    byDate := {}
    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        dp := StrSplit(A_LoopField, ",")
        if (dp.MaxIndex() < 10)
            continue
        dk := Trim(dp[2])
        dv := Trim(dp[10]) + 0
        if (dk = "")
            continue
        byDate[dk] := (byDate.HasKey(dk) ? byDate[dk] : 0) + dv
    }
    lst := ""
    for dk, dv in byDate {
        if (dv > 0)
            lst .= (lst = "" ? "" : "`n") . Round(dv * 10)
    }
    if (lst = "")
        return 0
    return MedianOf(lst) / 10.0
}

; The IVU slot carries goal progress once a goal exists, so the commitment is
; in front of you all day rather than only in the dashboard.
UpdateGoalUI() {
    global todayGoal, todayIVU, timerRunning
    if (timerRunning)
        return
    if (todayGoal > 0) {
        pctG := Round(todayIVU / todayGoal * 100)
        GuiControl, Main:, IVULabel, % "IVU " . pctG . "%"
    } else {
        GuiControl, Main:, IVULabel, IVU
    }
}

; Par for a study, in engaged seconds. 0 = unknown.
GetPar(examText, modality) {
    global examParMap, modParMap
    if (examText != "" && examParMap.HasKey(examText))
        return examParMap[examText]
    if (modality != "" && modParMap.HasKey(modality))
        return modParMap[modality]
    return 0
}

; The EXAMS/PAR slot. Par is shown while a study is running so the number you
; are betting against is always on screen.
UpdateCountArea() {
    global timerRunning, parSec, todayCount, parDlgOpen, parBase, parAdjust
    if (timerRunning && parSec > 0) {
        GuiControl, Main:, CountLabel, PAR
        GuiControl, Main:, CountDisplay, % FormatSeconds(Round(parSec))
    } else if (timerRunning) {
        GuiControl, Main:, CountLabel, PAR
        GuiControl, Main:, CountDisplay, --
    } else {
        GuiControl, Main:, CountLabel, EXAMS
        GuiControl, Main:, CountDisplay, %todayCount%
    }
    if (parDlgOpen) {
        GuiControl, ParDlg:, ParDlgVal, % (parSec > 0) ? FormatSeconds(Round(parSec)) : "--:--"
        adjTxt := (parAdjust = 0) ? "no adjustment" : ((parAdjust > 0 ? "+" : "-") . FormatSeconds(Abs(parAdjust)) . " vs suggested")
        sugTxt := (parBase > 0) ? ("suggested " . FormatSeconds(Round(parBase))) : "suggested par not known yet"
        GuiControl, ParDlg:, ParDlgSug, % sugTxt . "   " . Chr(0x00B7) . "   " . adjTxt
    }
}

; Reset the per-study bet. Called wherever a new study starts.
ParReset() {
    global parSec, parBase, parLocked, parAdjust, parProvisional
    parSec := 0
    parBase := 0
    parLocked := false
    parAdjust := 0
    parProvisional := false
}

; Scroll over the widget to move this study's par by PAR_STEP.
; Move this study's par. Always RELATIVE: par = suggested base + your
; adjustment, so a nudge made before the exam is even detected still applies
; once the suggestion lands. ParSuggested clears the adjustment.
ParShift(deltaSec) {
    global parSec, parBase, parAdjust, lastExamText, currentMod
    if (parSec <= 0) {
        seed := GetPar(lastExamText, currentMod)
        if (seed <= 0)
            seed := 300
        parBase := seed
        parSec := seed
    }
    np := parSec + deltaSec
    if (np < 30)
        np := 30
    parAdjust += (np - parSec)
    parSec := np
    UpdateCountArea()
    UpdateActivityUI()
}

ParNudge(dir) {
    global PAR_STEP
    ParShift(dir * PAR_STEP)
}

; Hotkey context: pointer over the widget while a study is running.
MouseOverWidget() {
    global MainHwnd, timerRunning, PAR_ENABLED
    if (!PAR_ENABLED || !timerRunning)
        return false
    MouseGetPos,,, wid
    return (wid = MainHwnd)
}

; Return the warning threshold (seconds) for a given exam/modality, or 0.
; The red overtime warning is no longer a separate idea: it is simply "well
; past par". One target, one escalation - WARN_PCT is now a percentage OF PAR.
GetWarnThreshold(examText, modality) {
    global WARN_PCT, WARN_FLOOR_SEC

    avg := GetPar(examText, modality)
    if (avg <= 0)
        return 0

    threshold := avg * (WARN_PCT / 100.0)
    ; Don't nag earlier than the absolute floor
    if (threshold < WARN_FLOOR_SEC)
        threshold := WARN_FLOOR_SEC
    return threshold
}

; ============================================================
;  EVENT CLASSIFICATION + BLOCK ATTRIBUTION
;  QGenda days carry several events: primary reading blocks
;  (BODY MR AM, STAT 12a-7a...), workflow modifiers (POC,
;  Readout, Conf, Chart Review), pay-code noise (Extra Hours)
;  and absences. Studies are attributed to the primary block
;  active at their sign minute.
; ============================================================

; Strip [Name] tags and swap annotations
CleanEventName(t) {
    t := RegExReplace(t, "\s*\[[^\]]*\]")
    t := RegExReplace(t, "i)\*?\s*swap.*$")
    return Trim(t)
}

; PRIMARY / MODIFIER / NOISE / OFF
ClassifyEvent(t) {
    global CLS_MOD_KEYS, CLS_OFF_KEYS, CLS_NOISE_KEYS
    StringUpper, u, t
    Loop, Parse, CLS_NOISE_KEYS, `,
        if InStr(u, A_LoopField)
            return "NOISE"
    Loop, Parse, CLS_OFF_KEYS, `,
        if InStr(u, A_LoopField)
            return "OFF"
    Loop, Parse, CLS_MOD_KEYS, `,
        if InStr(u, A_LoopField)
            return "MODIFIER"
    return "PRIMARY"
}

IsOnsiteEvent(t) {
    global CLS_ONSITE_RE
    if (CLS_ONSITE_RE = "")
        return false
    return RegExMatch(t, "i)" . CLS_ONSITE_RE) ? true : false
}

; Parse "8a-12:30p" style ranges from the event name.
ParseTimeWin(t, ByRef s, ByRef e) {
    if !RegExMatch(t, "i)(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])", m)
        return false
    s := Mod(m1, 12) + (m3 = "p" ? 12 : 0) + (m2 != "" ? m2 / 60.0 : 0)
    e := Mod(m4, 12) + (m6 = "p" ? 12 : 0) + (m5 != "" ? m5 / 60.0 : 0)
    if (e <= s)
        e += 24
    return true
}

; Window for an event: explicit range > AM/PM token > none (all-day)
EventWindow(t, ByRef s, ByRef e) {
    global WIN_AM_S, WIN_AM_E, WIN_PM_S, WIN_PM_E
    if ParseTimeWin(t, s, e)
        return true
    if RegExMatch(t, "i)\bAM\b") {
        s := WIN_AM_S, e := WIN_AM_E
        return true
    }
    if RegExMatch(t, "i)\bPM\b") {
        s := WIN_PM_S, e := WIN_PM_E
        return true
    }
    return false
}

; Build the day's plan: prims/mods arrays of {name, s, e, win, on}
BuildDayPlan(dateStr, ByRef prims, ByRef mods) {
    prims := [], mods := []
    raw := GetShiftForDate(dateStr)
    if (raw = "")
        return false
    hasExtra := false
    for idx, tok in StrSplit(raw, " / ") {
        c := CleanEventName(tok)
        if (c = "")
            continue
        cls := ClassifyEvent(c)
        if (cls = "PRIMARY") {
            s := 0, e := 24
            win := EventWindow(c, s, e)
            prims.Push({name: c, s: s, e: e, win: win, on: IsOnsiteEvent(c)})
        } else if (cls = "MODIFIER") {
            s := 0, e := 24
            win := EventWindow(c, s, e)
            mods.Push({name: c, s: s, e: e, win: win})
        } else if (cls = "NOISE") {
            StringUpper, cu, c
            if InStr(cu, "EXTRA HOURS")
                hasExtra := true
        }
    }
    if (prims.MaxIndex() = "" && hasExtra)
        prims.Push({name: "Extra Hours", s: 0, e: 24, win: false, on: false})
    return true
}

; Attribute a moment (decimal hour) to a primary block + concurrent extras.
AttributeMoment(dateStr, t, ByRef outShift, ByRef outExtras) {
    outShift := "", outExtras := ""
    prims := [], mods := []
    if !BuildDayPlan(dateStr, prims, mods)
        return false
    if (prims.MaxIndex() = "") {
        outShift := "Unscheduled"
        return true
    }
    best := "", bestW := 99, bestS := -1
    for i, p in prims {
        if (p.s <= t && t < p.e) {
            w := p.e - p.s
            if (w < bestW || (w = bestW && p.s > bestS)) {
                best := p.name, bestW := w, bestS := p.s
            }
        }
    }
    if (best = "") {
        bd := 99999, bs := -1
        for i, p in prims {
            d1 := Abs(t - p.s), d2 := Abs(t - p.e)
            d := (d1 < d2) ? d1 : d2
            if (d < bd || (d = bd && p.s > bs)) {
                best := p.name, bd := d, bs := p.s
            }
        }
    }
    outShift := best
    exList := ""
    for i, m in mods {
        hit := (!m.win) || (m.s <= t && t < m.e)
        if (hit)
            exList .= (exList != "" ? " + " : "") . m.name
    }
    outExtras := exList
    return true
}

; The primary block active right now (tray tip + popups)
UpdateCurrentBlock() {
    global currentBlock, currentExtras, todayShift
    FormatTime, dNow,, M/d/yyyy
    t := A_Hour + (A_Min / 60.0)
    sh := "", ex := ""
    AttributeMoment(dNow, t, sh, ex)
    currentBlock := sh
    currentExtras := ex
    todayShift := sh
}

; Sum of typical IVU across today's primary blocks (daily goal prefill)
GetTodayTypicalTotal(ByRef nBlocks) {
    global
    FormatTime, gttD,, M/d/yyyy
    gttP := [], gttM := []
    nBlocks := 0
    tot := 0.0
    if !BuildDayPlan(gttD, gttP, gttM)
        return 0
    for i, p in gttP {
        nB := 0
        tot += GetShiftTypical(p.name, nB)
        nBlocks++
    }
    return tot
}

; Today's IVU logged within the given block (lazy scan)
GetTodayBlockIVU(blockName) {
    global LOG_FILE
    if (blockName = "" || !FileExist(LOG_FILE))
        return 0
    FormatTime, tbD,, M/d/yyyy
    sum := 0.0
    FileRead, tbData, %LOG_FILE%
    Loop, Parse, tbData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 10 || Trim(p[2]) != tbD)
            continue
        sh := (p.MaxIndex() >= 11) ? Trim(p[11]) : ""
        if (sh = blockName)
            sum += Trim(p[10]) + 0.0
    }
    return sum
}

; ============================================================
;  SHIFT STATS - historical per-shift-type performance
;  Per worked date: total IVU + study count, tagged with the
;  shift (CSV col 11, falling back to the QGenda map so it
;  works even before Backfill has run). Excludes today so
;  "typical" isn't diluted by the in-progress day.
; ============================================================

LoadShiftStats() {
    global LOG_FILE, shiftStatAvgIVU, shiftStatDays
    global overallDayAvgIVU, overallDayCount, shiftStatHrs, shiftOnsite

    shiftStatAvgIVU := {}
    shiftStatDays := {}
    shiftStatHrs := {}
    shiftOnsite := {}
    overallDayAvgIVU := 0
    overallDayCount := 0
    if !FileExist(LOG_FILE)
        return

    FormatTime, todayD,, M/d/yyyy
    ; Unit = block instance: "date|blockName"
    blkIVU := {}, blkShift := {}, blkDate := {}

    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 7)
            continue
        d := Trim(p[2])
        if (d = "" || d = todayD)
            continue
        ivu := (p.MaxIndex() >= 10) ? Trim(p[10]) + 0.0 : 0.0
        sh := (p.MaxIndex() >= 11) ? Trim(p[11]) : ""
        if (sh = "") {
            ; legacy row: attribute on the fly from timestamp
            hr := Trim(p[4]) + 0
            mn := 30
            if RegExMatch(Trim(p[1]), "\s(\d{1,2}):(\d{2})$", tm) {
                hr := tm1 + 0
                mn := tm2 + 0
            }
            ex := ""
            AttributeMoment(d, hr + mn/60.0, sh, ex)
        }
        if (sh = "")
            continue
        bk := d . "|" . sh
        blkIVU[bk] := (blkIVU.HasKey(bk) ? blkIVU[bk] : 0.0) + ivu
        blkShift[bk] := sh
        blkDate[bk] := d
    }

    sumI := {}, cnt := {}, sumH := {}, cntH := {}
    totI := 0.0
    for bk, iv in blkIVU {
        totI += iv
        overallDayCount++
        s := blkShift[bk]
        sumI[s] := (sumI.HasKey(s) ? sumI[s] : 0.0) + iv
        cnt[s] := (cnt.HasKey(s) ? cnt[s] : 0) + 1
        ; scheduled hours from that day's plan
        pr := [], md := []
        if BuildDayPlan(blkDate[bk], pr, md) {
            for i, pp in pr {
                if (pp.name = s && pp.win) {
                    sumH[s] := (sumH.HasKey(s) ? sumH[s] : 0.0) + (pp.e - pp.s)
                    cntH[s] := (cntH.HasKey(s) ? cntH[s] : 0) + 1
                    if (pp.on)
                        shiftOnsite[s] := true
                    break
                }
            }
        }
    }
    if (overallDayCount > 0)
        overallDayAvgIVU := totI / overallDayCount
    for s, c in cnt {
        shiftStatDays[s] := c
        shiftStatAvgIVU[s] := sumI[s] / c
        if (cntH.HasKey(s) && cntH[s] > 0)
            shiftStatHrs[s] := sumH[s] / cntH[s]
    }
}

; Typical IVU per BLOCK for a shift name; falls back to overall. n by ref.
GetShiftTypical(shiftName, ByRef nDays) {
    global shiftStatAvgIVU, shiftStatDays, overallDayAvgIVU, overallDayCount
    if (shiftName != "" && shiftStatAvgIVU.HasKey(shiftName) && shiftStatDays[shiftName] >= 2) {
        nDays := shiftStatDays[shiftName]
        return shiftStatAvgIVU[shiftName]
    }
    nDays := overallDayCount
    return overallDayAvgIVU
}

; ============================================================
;  PERSISTENT SETTINGS (RadTempo.ini)
; ============================================================

LoadSettings() {
    global INI_FILE, warnEnabled, WARN_PCT, wellnessMinutes, STREAK_LIMIT
    global forecastGoal, SHIFT_ICAL_URL, ACT_ENABLED, ACT_IDLE_MS
    global wellNextMs, BREAK_MIN_MS
    global parStreak, parBestStreak, PAR_ENABLED, HOURLY_RATE
    global CLS_MOD_KEYS, CLS_OFF_KEYS, CLS_NOISE_KEYS, CLS_ONSITE_RE
    global WIN_AM_S, WIN_AM_E, WIN_PM_S, WIN_PM_E
    global FILLER_NAME, FILLER_MATCH, FILLER_IVU, GOAL_BASE, GOAL_STEP
    global REWARD_ENABLED, REWARD_PER_POINT, REWARD_RUNG_PTS, REWARD_STREAK_EVERY
    global REWARD_STREAK_BONUS, REWARD_WEEK_CAP, REWARD_STORE_URL, REWARD_START
    global CAL_SCALE, STALE_STUDY_MIN

    IniRead, v, %INI_FILE%, Settings, StaleStudyMin, 240
    if v is integer
        if (v >= 60)
            STALE_STUDY_MIN := v

    IniRead, v, %INI_FILE%, Settings, WarnEnabled, 1
    warnEnabled := (v != "0")

    IniRead, v, %INI_FILE%, Settings, WarnPct, 150
    if v is integer
        WARN_PCT := v

    IniRead, v, %INI_FILE%, Settings, WellnessMinutes, 90
    wellnessMinutes := (v = "60") ? 60 : 90
    STREAK_LIMIT := wellnessMinutes * 60000
    wellNextMs := STREAK_LIMIT

    ; How long you must be physically away for it to count as a break.
    IniRead, v, %INI_FILE%, Settings, BreakMinutes, 2
    if v is number
        if (v > 0 && v <= 30)
            BREAK_MIN_MS := Round(v * 60000)

    IniRead, v, %INI_FILE%, Settings, ForecastGoal, %A_Space%
    if (v != "" && v != "ERROR")
        forecastGoal := v

    IniRead, v, %INI_FILE%, Settings, ActivityEnabled, 1
    ACT_ENABLED := (v != "0")

    IniRead, v, %INI_FILE%, Settings, HourlyRate, %A_Space%
    if (v != "" && v != "ERROR" && v + 0 > 0)
        HOURLY_RATE := v + 0

    ; Filler exam - the unit the dashboard converts deficits and lost time into
    IniRead, v, %INI_FILE%, Settings, FillerName, %A_Space%
    if (v != "" && v != "ERROR")
        FILLER_NAME := v
    IniRead, v, %INI_FILE%, Settings, FillerMatch, %A_Space%
    if (v != "" && v != "ERROR")
        FILLER_MATCH := v
    IniRead, v, %INI_FILE%, Settings, FillerIVU, %A_Space%
    if (v != "" && v != "ERROR" && v + 0 > 0)
        FILLER_IVU := v + 0

    ; IVU per PowerScribe RVU. Left at 1 unless the two are genuinely
    ; different units.
    IniRead, v, %INI_FILE%, Settings, IvuPerRvu, %A_Space%
    if (v != "" && v != "ERROR" && v + 0 > 0)
        CAL_SCALE := v + 0.0

    ; Goal rungs
    IniRead, v, %INI_FILE%, Settings, GoalBase, 60
    if v is number
        if (v >= 0)
            GOAL_BASE := v + 0
    IniRead, v, %INI_FILE%, Settings, GoalStep, 7
    if v is number
        if (v > 0)
            GOAL_STEP := v + 0

    ; Reward bank
    IniRead, v, %INI_FILE%, Settings, RewardEnabled, 1
    REWARD_ENABLED := (v != "0")
    IniRead, v, %INI_FILE%, Settings, RewardPerPoint, %A_Space%
    if (v != "" && v != "ERROR" && v + 0 >= 0)
        REWARD_PER_POINT := v + 0.0
    IniRead, v, %INI_FILE%, Settings, RewardRungPts, 10
    if v is number
        if (v > 0)
            REWARD_RUNG_PTS := v + 0
    IniRead, v, %INI_FILE%, Settings, RewardStreakEvery, 5
    if v is integer
        if (v > 0)
            REWARD_STREAK_EVERY := v
    IniRead, v, %INI_FILE%, Settings, RewardStreakBonus, 3
    if v is number
        if (v >= 0)
            REWARD_STREAK_BONUS := v + 0
    IniRead, v, %INI_FILE%, Settings, RewardWeekCap, 150
    if v is number
        if (v > 0)
            REWARD_WEEK_CAP := v + 0
    IniRead, v, %INI_FILE%, Settings, RewardStoreUrl, %A_Space%
    if (v != "" && v != "ERROR")
        REWARD_STORE_URL := v
    IniRead, v, %INI_FILE%, Settings, RewardStartDate, %A_Space%
    if (v != "" && v != "ERROR" && StrLen(v) = 8) {
        REWARD_START := v
    } else {
        FormatTime, REWARD_START,, yyyyMMdd
        SaveSetting("RewardStartDate", REWARD_START)
    }

    IniRead, v, %INI_FILE%, Settings, ParStreak, 0
    if v is integer
        parStreak := v
    IniRead, v, %INI_FILE%, Settings, ParBestStreak, 0
    if v is integer
        parBestStreak := v

    IniRead, v, %INI_FILE%, Settings, ActivityIdleSec, 60
    if v is integer
        if (v >= 10 && v <= 600)
            ACT_IDLE_MS := v * 1000

    ; Shift URL can be overridden from the INI without editing code
    IniRead, v, %INI_FILE%, Settings, ShiftUrl, %A_Space%
    if (v != "" && v != "ERROR")
        SHIFT_ICAL_URL := Trim(v)

    ; Event classification lists + block windows (tunable without code)
    IniRead, v, %INI_FILE%, ShiftClass, ModifierKeys, %A_Space%
    if (v != "" && v != "ERROR")
        CLS_MOD_KEYS := v
    else
        IniWrite, %CLS_MOD_KEYS%, %INI_FILE%, ShiftClass, ModifierKeys
    IniRead, v, %INI_FILE%, ShiftClass, OffKeys, %A_Space%
    if (v != "" && v != "ERROR")
        CLS_OFF_KEYS := v
    else
        IniWrite, %CLS_OFF_KEYS%, %INI_FILE%, ShiftClass, OffKeys
    IniRead, v, %INI_FILE%, ShiftClass, NoiseKeys, %A_Space%
    if (v != "" && v != "ERROR")
        CLS_NOISE_KEYS := v
    else
        IniWrite, %CLS_NOISE_KEYS%, %INI_FILE%, ShiftClass, NoiseKeys
    IniRead, v, %INI_FILE%, ShiftClass, OnsiteRegex, %A_Space%
    if (v != "" && v != "ERROR")
        CLS_ONSITE_RE := v
    else
        IniWrite, %CLS_ONSITE_RE%, %INI_FILE%, ShiftClass, OnsiteRegex
    IniRead, v, %INI_FILE%, ShiftClass, AmStart, 8.0
    WIN_AM_S := v + 0
    IniRead, v, %INI_FILE%, ShiftClass, AmEnd, 12.5
    WIN_AM_E := v + 0
    IniRead, v, %INI_FILE%, ShiftClass, PmStart, 12.5
    WIN_PM_S := v + 0
    IniRead, v, %INI_FILE%, ShiftClass, PmEnd, 17.0
    WIN_PM_E := v + 0
}

SaveSetting(key, val) {
    global INI_FILE
    IniWrite, %val%, %INI_FILE%, Settings, %key%
}

; Reflect loaded settings in the tray menu checkmarks
ApplySettingsChecks() {
    global warnEnabled, WARN_PCT, wellnessMinutes, ACT_ENABLED, ACT_IDLE_MS
    if (ACT_ENABLED) {
        Menu, ActMenu, Check, Turn On
        Menu, ActMenu, Uncheck, Turn Off
    } else {
        Menu, ActMenu, Check, Turn Off
        Menu, ActMenu, Uncheck, Turn On
    }
    Menu, ActMenu, Uncheck, Away after 30s
    Menu, ActMenu, Uncheck, Away after 60s
    Menu, ActMenu, Uncheck, Away after 90s
    Menu, ActMenu, Check, % "Away after " . Round(ACT_IDLE_MS / 1000) . "s"
    if (warnEnabled) {
        Menu, SpeedMenu, Check, Turn On
        Menu, SpeedMenu, Uncheck, Turn Off
    } else {
        Menu, SpeedMenu, Check, Turn Off
        Menu, SpeedMenu, Uncheck, Turn On
    }
    Menu, SpeedMenu, Uncheck, Warn at 125`%
    Menu, SpeedMenu, Uncheck, Warn at 150`%
    Menu, SpeedMenu, Uncheck, Warn at 200`%
    if (WARN_PCT = 125)
        Menu, SpeedMenu, Check, Warn at 125`%
    else if (WARN_PCT = 200)
        Menu, SpeedMenu, Check, Warn at 200`%
    else
        Menu, SpeedMenu, Check, Warn at 150`%
    if (wellnessMinutes = 60) {
        Menu, WellnessMenu, Check, Set to 60 min
        Menu, WellnessMenu, Uncheck, Set to 90 min
    } else {
        Menu, WellnessMenu, Check, Set to 90 min
        Menu, WellnessMenu, Uncheck, Set to 60 min
    }
}

; Tray tooltip: state + count + today's shift
UpdateTrayTip() {
    global timerRunning, currentMod, todayCount, todayShift, currentExtras
    tip := "RadTempo"
    if (timerRunning)
        tip .= " - RUNNING (" . currentMod . ")"
    else if (todayCount > 0)
        tip .= " - " . todayCount . " today"
    if (todayShift != "")
        tip .= " | " . todayShift
    if (currentExtras != "")
        tip .= " (+" . currentExtras . ")"
    if (StrLen(tip) > 127)
        tip := SubStr(tip, 1, 124) . "..."
    Menu, Tray, Tip, %tip%
}

; ============================================================
;  QGENDA SHIFT SCHEDULE (iCal)
;  Fetches the personal iCal feed, parses VEVENTs into a
;  date -> shift-name map, caches locally so the tool works
;  offline and starts instantly.
; ============================================================

; Convert "20260509" -> "5/9/2026" (matches CSV date format)
ICalYmdToMDY(ymd) {
    y := SubStr(ymd, 1, 4)
    mo := SubStr(ymd, 5, 2) + 0
    d := SubStr(ymd, 7, 2) + 0
    return mo . "/" . d . "/" . y
}

; Convert "5/9/2026" -> "20260509" (for sorting)
MDYToYmd(mdy) {
    p := StrSplit(mdy, "/")
    if (p.MaxIndex() < 3)
        return ""
    return p[3] . Format("{:02}", p[1] + 0) . Format("{:02}", p[2] + 0)
}

GetShiftForDate(dateStr) {
    global shiftByDate
    if (dateStr != "" && shiftByDate.HasKey(dateStr))
        return shiftByDate[dateStr]
    return ""
}

; Parse iCal text into the shiftByDate map. Returns count of dates.
ParseICalToMap(ics) {
    global shiftByDate, shiftCount
    newMap := {}
    n := 0
    fetchMin := "99999999"
    fetchMax := "00000000"

    ; Unfold wrapped lines (CRLF or LF followed by space/tab)
    f1 := Chr(13) . Chr(10) . " "
    f2 := Chr(13) . Chr(10) . Chr(9)
    f3 := Chr(10) . " "
    f4 := Chr(10) . Chr(9)
    StringReplace, ics, ics, %f1%, , All
    StringReplace, ics, ics, %f2%, , All
    StringReplace, ics, ics, %f3%, , All
    StringReplace, ics, ics, %f4%, , All

    inEv := false
    dtS := "", dtE := "", summ := ""

    Loop, Parse, ics, `n, `r
    {
        line := Trim(A_LoopField)
        if (line = "BEGIN:VEVENT") {
            inEv := true
            dtS := "", dtE := "", summ := ""
            continue
        }
        if (line = "END:VEVENT") {
            inEv := false
            if (dtS != "" && summ != "") {
                ; DTEND for all-day events is exclusive; expand range
                endYmd := dtS
                if (dtE != "" && dtE > dtS) {
                    e := dtE . "000000"
                    EnvAdd, e, -1, Days
                    endYmd := SubStr(e, 1, 8)
                    if (endYmd < dtS)
                        endYmd := dtS
                }
                ; Track the span the feed actually covers
                if (dtS < fetchMin)
                    fetchMin := dtS
                if (endYmd > fetchMax)
                    fetchMax := endYmd
                cur := dtS
                Loop, 62 {
                    key := ICalYmdToMDY(cur)
                    if (newMap.HasKey(key)) {
                        if (!InStr(newMap[key], summ))
                            newMap[key] .= " / " . summ
                    } else {
                        newMap[key] := summ
                        n++
                    }
                    if (cur >= endYmd)
                        break
                    c := cur . "000000"
                    EnvAdd, c, 1, Days
                    cur := SubStr(c, 1, 8)
                }
            }
            continue
        }
        if (!inEv)
            continue

        if RegExMatch(line, "^DTSTART[^:]*:(\d{8})", m)
            dtS := m1
        else if RegExMatch(line, "^DTEND[^:]*:(\d{8})", m)
            dtE := m1
        else if RegExMatch(line, "^SUMMARY[^:]*:(.*)$", m) {
            s := m1
            ; Unescape iCal text, then sanitize for CSV
            StringReplace, s, s, \\, %A_Space%, All
            StringReplace, s, s, \`,, %A_Space%, All
            StringReplace, s, s, \;, ;, All
            StringReplace, s, s, \n, %A_Space%, All
            StringReplace, s, s, `,, %A_Space%, All
            s := RegExReplace(s, "\s+", " ")
            summ := Trim(s)
        }
    }

    if (n > 0) {
        ; QGenda feeds are a rolling window. Feed content is authoritative
        ; INSIDE the span it covers (propagates swaps and deletions), but
        ; dates that have rolled OUT of the feed are kept from the cache
        ; so the historical correlation is never lost.
        merged := {}
        total := 0
        for k, v in shiftByDate {
            y := MDYToYmd(k)
            if (y != "" && (y < fetchMin || y > fetchMax)) {
                merged[k] := v
                total++
            }
        }
        for k, v in newMap {
            if (!merged.HasKey(k))
                total++
            merged[k] := v
        }
        shiftByDate := merged
        shiftCount := total
    }
    return n
}

; Fetch the iCal feed. Returns "" on success, or an error message.
FetchShiftsNow() {
    global SHIFT_ICAL_URL, shiftLastFetch

    if (SHIFT_ICAL_URL = "")
        return "No QGenda link set. Add a line ShiftUrl=<your QGenda iCal link> under [Settings] in RadTempo.ini, then restart."

    ics := ""
    try {
        http := ComObjCreate("WinHttp.WinHttpRequest.5.1")
        http.SetTimeouts(5000, 5000, 8000, 15000)
        http.Open("GET", SHIFT_ICAL_URL, false)
        http.Send()
        if (http.Status != 200)
            return "HTTP " . http.Status . " from QGenda"
        ics := http.ResponseText
    } catch e {
        return "Fetch failed: " . e.Message
    }

    if (!InStr(ics, "BEGIN:VCALENDAR"))
        return "Response is not an iCal feed"

    n := ParseICalToMap(ics)
    if (n = 0)
        return "Feed parsed but contained no events"

    FormatTime, shiftLastFetch,, yyyyMMddHHmmss
    return ""
}

; Save the parsed map to a local cache so startup is instant/offline
SaveShiftCache() {
    global SHIFT_CACHE, shiftByDate, shiftLastFetch
    fh := FileOpen(SHIFT_CACHE, "w", "UTF-8-RAW")
    if (!fh)
        return
    fh.Write("#fetched," . shiftLastFetch . "`n")
    for k, v in shiftByDate
        fh.Write(k . "," . v . "`n")
    fh.Close()
}

LoadShiftCache() {
    global SHIFT_CACHE, shiftByDate, shiftCount, shiftLastFetch
    shiftByDate := {}
    shiftCount := 0
    if !FileExist(SHIFT_CACHE)
        return
    FileRead, data, %SHIFT_CACHE%
    Loop, Parse, data, `n, `r
    {
        line := Trim(A_LoopField)
        if (line = "")
            continue
        if (SubStr(line, 1, 9) = "#fetched,") {
            shiftLastFetch := SubStr(line, 10)
            continue
        }
        cp := InStr(line, ",")
        if (cp < 2)
            continue
        d := SubStr(line, 1, cp - 1)
        s := SubStr(line, cp + 1)
        shiftByDate[d] := s
        shiftCount++
    }
}

; One-shot background refresh (silent; cache stays valid on failure)
FetchShiftsKick:
    kErr := FetchShiftsNow()
    if (kErr = "") {
        SaveShiftCache()
        LoadShiftStats()
        UpdateCurrentBlock()
        UpdateTrayTip()
    }
return

; Persist widget position if the user dragged it
PosSaveCheck:
    WinGetPos, pX, pY,,, ahk_id %MainHwnd%
    if (pX = "" || pY = "")
        return
    if (pX != lastSavedPosX || pY != lastSavedPosY) {
        IniWrite, %pX%, %INI_FILE%, Window, PosX
        IniWrite, %pY%, %INI_FILE%, Window, PosY
        lastSavedPosX := pX
        lastSavedPosY := pY
    }
return

; ============================================================
;  SHIFT MENU HANDLERS
; ============================================================

MenuShiftToday:
    UpdateCurrentBlock()
    FormatTime, dT,, M/d/yyyy
    tm := A_Now
    EnvAdd, tm, 1, Days
    FormatTime, dTom, %tm%, M/d/yyyy

    msg := "TODAY (" . dT . "):`n" . DescribeDayPlan(dT)
    msg .= "`nActive now: " . (currentBlock != "" ? currentBlock : "(none)")
    if (currentExtras != "")
        msg .= "  +  " . currentExtras
    msg .= "`n`nTOMORROW (" . dTom . "):`n" . DescribeDayPlan(dTom)
    if (shiftLastFetch != "") {
        FormatTime, ft, %shiftLastFetch%, M/d h:mm tt
        msg .= "`n`nSchedule refreshed: " . ft . "  |  dates cached: " . shiftCount
    }
    MsgBox, 64, RadTempo - Shift Plan, %msg%
return

; Human-readable plan for one date
DescribeDayPlan(dateStr) {
    prims := [], mods := []
    if (!BuildDayPlan(dateStr, prims, mods))
        return "    (no schedule)`n"
    out := ""
    for i, p in prims {
        w := p.win ? ("  " . FmtHour(p.s) . "-" . FmtHour(p.e)) : "  (all day)"
        tag := p.on ? "  [on-site]" : ""
        out .= "    " . p.name . w . tag . "`n"
    }
    if (prims.MaxIndex() = "")
        out .= "    (no reading blocks)`n"
    for i, m in mods {
        w := m.win ? ("  " . FmtHour(m.s) . "-" . FmtHour(m.e)) : ""
        out .= "      + " . m.name . w . "`n"
    }
    return out
}

FmtHour(h) {
    hh := Floor(h)
    mm := Round((h - hh) * 60)
    if (hh >= 24)
        hh -= 24
    return hh . ":" . Format("{:02}", mm)
}

MenuShiftView:
    if (shiftCount = 0) {
        MsgBox, 48, Shift Schedule, No schedule loaded yet.`n`nUse "Refresh from QGenda" to fetch it.
        return
    }
    ; Show a window from 7 days back to 30 days ahead, sorted
    FormatTime, todayYmd,, yyyyMMdd
    lo := todayYmd . "000000"
    EnvAdd, lo, -7, Days
    lo := SubStr(lo, 1, 8)
    hi := todayYmd . "000000"
    EnvAdd, hi, 30, Days
    hi := SubStr(hi, 1, 8)

    listStr := ""
    for k, v in shiftByDate {
        y := MDYToYmd(k)
        if (y >= lo && y <= hi)
            listStr .= y . "`t" . k . "  -  " . v . "`n"
    }
    Sort, listStr
    out := ""
    Loop, Parse, listStr, `n
    {
        if (A_LoopField = "")
            continue
        tabPos := InStr(A_LoopField, "`t")
        row := SubStr(A_LoopField, tabPos + 1)
        ymdKey := SubStr(A_LoopField, 1, 8)
        marker := (ymdKey = todayYmd) ? "  << TODAY" : ""
        out .= row . marker . "`n"
    }
    if (out = "")
        out := "(no shifts in the -7 to +30 day window)"
    MsgBox, 64, Shift Schedule (-7 to +30 days), %out%
return

MenuShiftRefresh:
    ToolTip, Fetching QGenda schedule..., 0, 0
    rErr := FetchShiftsNow()
    ToolTip
    if (rErr != "") {
        MsgBox, 48, Shift Refresh, Refresh failed:`n`n%rErr%`n`nThe cached schedule (if any) is still in use.
        return
    }
    SaveShiftCache()
    LoadShiftStats()
    UpdateCurrentBlock()
    UpdateTrayTip()
    MsgBox, 64, Shift Refresh, % "Schedule refreshed.`n`nDates loaded: " . shiftCount . "`nToday: " . (todayShift != "" ? todayShift : "(none)")
return

MenuShiftBackfill:
    if (shiftCount = 0) {
        MsgBox, 48, Backfill Shifts, No schedule loaded. Refresh from QGenda first.
        return
    }
    if !FileExist(LOG_FILE) {
        MsgBox, 48, Backfill Shifts, No log file found.
        return
    }

    FileRead, bfData, %LOG_FILE%
    bfLines := StrSplit(bfData, "`n", "`r")
    if (bfLines.MaxIndex() < 2) {
        MsgBox, 64, Backfill Shifts, Log file is empty.
        return
    }

    ; Backup first
    bkFile := LOG_FILE . ".shiftbak"
    FileCopy, %LOG_FILE%, %bkFile%, 1

    ; Header: ensure Shift + Extras columns
    hdr := Trim(bfLines[1])
    if (!InStr(hdr, ",Shift"))
        hdr .= ",Shift"
    if (!InStr(hdr, ",Extras"))
        hdr .= ",Extras"

    attributed := 0
    unsched := 0
    kept := 0
    outStr := hdr . "`n"
    Loop, % bfLines.MaxIndex() {
        if (A_Index = 1)
            continue
        line := Trim(bfLines[A_Index])
        if (line = "")
            continue
        p := StrSplit(line, ",")
        while (p.MaxIndex() < 10)
            p.Push("")
        rowDate := Trim(p[2])

        ; Sign moment: minute-precise from Timestamp, else Hour col + :30
        hr := Trim(p[4]) + 0
        mn := 30
        if RegExMatch(Trim(p[1]), "\s(\d{1,2}):(\d{2})$", tm) {
            hr := tm1 + 0
            mn := tm2 + 0
        }

        sh := "", ex := ""
        if (rowDate != "" && GetShiftForDate(rowDate) != "") {
            AttributeMoment(rowDate, hr + mn/60.0, sh, ex)
            if (sh = "Unscheduled")
                unsched++
            else if (sh != "")
                attributed++
        } else {
            ; No schedule for this date: preserve whatever is there
            sh := (p.MaxIndex() >= 11) ? Trim(p[11]) : ""
            ex := (p.MaxIndex() >= 12) ? Trim(p[12]) : ""
        }

        newLine := ""
        Loop, 10 {
            if (A_Index > 1)
                newLine .= ","
            newLine .= p[A_Index]
        }
        newLine .= "," . sh . "," . ex
        ; Preserve any columns beyond Extras (ActiveSec and anything added
        ; later). Rebuilding only through col 12 would silently drop them.
        if (p.MaxIndex() >= 13) {
            Loop, % p.MaxIndex() - 12
                newLine .= "," . p[12 + A_Index]
        }
        outStr .= newLine . "`n"
        kept++
    }

    fh := FileOpen(LOG_FILE, "w", "UTF-8-RAW")
    if (!fh) {
        MsgBox, 48, Backfill Shifts, Could not write to log file (is it open in Excel?).`nBackup saved at:`n%bkFile%
        return
    }
    fh.Write(outStr)
    fh.Close()

    LoadShiftStats()
    bfMsg := "Backfill complete (block-level attribution).`n`nRows processed: " . kept . "`nAttributed to a block: " . attributed . "`nUnscheduled: " . unsched . "`n`nBackup saved to:`n" . bkFile
    MsgBox, 64, Backfill Shifts, %bfMsg%
return

; ============================================================
;  IVU LOOKUP TABLE - Load and fuzzy match
; ============================================================

LoadIVUTable() {
    global IVU_FILE, ivuDescs, ivuValues, ivuCodes

    if !FileExist(IVU_FILE)
        return

    FileRead, ivuData, %IVU_FILE%
    Loop, Parse, ivuData, `n, `r
    {
        if (A_Index = 1)  ; skip header
            continue
        if (A_LoopField = "")
            continue
        ; Parse: Code,Description,IVU
        parts := StrSplit(A_LoopField, ",")
        if (parts.MaxIndex() < 3)
            continue
        code := Trim(parts[1])
        desc := parts[2]
        val := parts[3] + 0.0
        StringUpper, code, code
        StringUpper, desc, desc
        desc := NormalizeExamText(desc)
        ivuCodes.Push(code)
        ivuDescs.Push(desc)
        ivuValues.Push(val)
    }
}

; IVU of one filler exam. The INI override wins; otherwise it is the median of
; every IVU-table row whose description matches FILLER_MATCH (median, because a
; loose pattern can catch a neighbouring code and a mean would then be wrong for
; every row). Returns 0 when the table has nothing - the dashboard falls back to
; the value recorded in the user's own log, which is the authoritative one.
FillerIVU() {
    global ivuDescs, ivuValues, FILLER_MATCH, FILLER_IVU
    if (FILLER_IVU + 0 > 0)
        return FILLER_IVU + 0
    lst := ""
    Loop, % ivuDescs.MaxIndex() {
        ; "i)" is AHK's case-insensitive prefix, applied here rather than baked
        ; into the pattern: the same string is handed to JS as new RegExp(re,"i"),
        ; where an "i)" prefix would be a syntax error. Keep FILLER_MATCH plain.
        if RegExMatch(ivuDescs[A_Index], "i)" . FILLER_MATCH)
            lst .= (lst = "" ? "" : "`n") . Round(ivuValues[A_Index] * 100)
    }
    if (lst = "")
        return 0
    return MedianOf(lst) / 100.0
}

; Daily credits earned at an IVU total: (v - GOAL_BASE) / GOAL_STEP, floored.
; One credit is one hour. Floored on purpose - finishing between two rungs pays
; the rung below, which is the whole reason the presets sit ON rungs.
GoalCredits(v) {
    global GOAL_BASE, GOAL_STEP
    if (GOAL_STEP <= 0 || v < GOAL_BASE)
        return 0
    return Floor((v - GOAL_BASE) / GOAL_STEP + 0.0001)
}

; Lowest goal rung strictly above v (the floor, if v is below it).
NextRung(v) {
    global GOAL_BASE, GOAL_STEP
    if (GOAL_STEP <= 0)
        return v
    if (v < GOAL_BASE)
        return GOAL_BASE
    r := GOAL_BASE + (Floor((v - GOAL_BASE) / GOAL_STEP) + 1) * GOAL_STEP
    while (r <= v + 0.001)   ; float slop: never hand back a rung at or below v
        r += GOAL_STEP
    return r
}

; "74 IVU = 2 credits, at 31.5" - the goal confirmation, everywhere it is shown.
GoalBlurb(v) {
    global todayIVU
    c := GoalCredits(v)
    s := Format("{:.1f}", v) . " IVU"
    if (c > 0)
        s .= " = " . c . (c = 1 ? " credit" : " credits")
    return s . "   (at " . Format("{:.1f}", todayIVU) . ")"
}

; The next few rungs from v, for the goal prompt.
RungList(v) {
    out := "", r := v
    Loop, 4 {
        r := NextRung(r)
        out .= (out = "" ? "" : ", ") . Format("{:.4g}", r)
    }
    return out
}

; Look up IVU by Sectra exam code (exact match)
FindIVUByCode(code) {
    global ivuCodes, ivuValues
    StringUpper, codeU, code
    Loop, % ivuCodes.MaxIndex() {
        if (ivuCodes[A_Index] = codeU)
            return ivuValues[A_Index]
    }
    return 0.0
}

NormalizeExamText(txt) {
    StringUpper, txt, txt
    ; Normalize contrast abbreviations
    txt := RegExReplace(txt, "\bW/O\b", "NO")
    txt := RegExReplace(txt, "\bWO\b", "NO")
    txt := RegExReplace(txt, "\bWITHOUT\b", "NO")
    txt := RegExReplace(txt, "\bW/\b", "W")
    txt := RegExReplace(txt, "\bWITH\b", "W")
    txt := RegExReplace(txt, "\bWO/W\b", "NO AND W")
    ; Expand common abbreviations so input and table match
    txt := RegExReplace(txt, "\bABD\b", "ABDOMEN")
    txt := RegExReplace(txt, "\bPEL\b", "PELVIS")
    txt := RegExReplace(txt, "\bCHES\b", "CHEST")
    txt := RegExReplace(txt, "\bEXTREM\b", "EXTREMITY")
    txt := RegExReplace(txt, "\bEXTRM\b", "EXTREMITY")
    txt := RegExReplace(txt, "\bNEC\b", "NECK")
    txt := RegExReplace(txt, "\bBILAT\b", "BILATERAL")
    txt := RegExReplace(txt, "\bLT\b", "LEFT")
    txt := RegExReplace(txt, "\bRT\b", "RIGHT")
    txt := RegExReplace(txt, "\bCSP\b", "CERVICAL SPINE")
    txt := RegExReplace(txt, "\bTSP\b", "THORACIC SPINE")
    txt := RegExReplace(txt, "\bLSP\b", "LUMBAR SPINE")
    ; Strip punctuation except spaces
    txt := RegExReplace(txt, "[^A-Z0-9 ]", " ")
    ; Collapse whitespace
    txt := RegExReplace(txt, "\s+", " ")
    txt := Trim(txt)
    return txt
}

IVU_Lookup(examText) {
    global ivuDescs, ivuValues, lastNumExams

    if (examText = "" || ivuDescs.MaxIndex() = 0) {
        lastNumExams := 1
        return 0.00
    }

    ; Split into separate exams when multiple are linked.
    exams := SplitMultiExam(examText)
    lastNumExams := exams.MaxIndex()

    sumIVU := 0.0
    for i, exam in exams {
        val := IVU_LookupSingle(exam)
        sumIVU += val
    }

    return sumIVU
}

; Split exam text into separate exams at modality boundaries
SplitMultiExam(examText) {
    ; Normalize first
    StringUpper, txt, examText
    ; Split at word boundaries before modality prefixes (but not the first one).
    ; The prefix list used for splitting is the inline StrSplit(...) in the loop below.

    ; Replace commas with spaces first
    StringReplace, txt, txt, `,, %A_Space%, All
    txt := RegExReplace(txt, "\s+", " ")
    txt := Trim(txt)

    results := []

    ; Find all positions where a modality prefix starts
    positions := [1]  ; first exam always starts at 1
    pos := 2
    Loop {
        ; Search for next modality prefix after position
        found := 0
        bestPos := 0
        for i, pfx in StrSplit("XR ,CT ,CTA ,CTV ,MR ,MRI ,MRA ,MRV ,US ,NM ,PET ,DEXA ,FLUORO ,FLUOROSCOPY ,MAMMO ", ",") {
            pfx := Trim(pfx)
            if (pfx = "")
                continue
            p := InStr(txt, " " . pfx, false, pos)
            if (p > 0 && (bestPos = 0 || p < bestPos))
                bestPos := p
        }
        if (bestPos > 0) {
            positions.Push(bestPos + 1)  ; +1 to skip the space
            pos := bestPos + 2
        } else
            break
        if (pos > StrLen(txt))
            break
    }

    ; Extract each exam substring
    Loop, % positions.MaxIndex() {
        startPos := positions[A_Index]
        if (A_Index < positions.MaxIndex())
            endPos := positions[A_Index + 1] - 1
        else
            endPos := StrLen(txt)
        segment := Trim(SubStr(txt, startPos, endPos - startPos + 1))
        if (segment != "")
            results.Push(segment)
    }

    ; If splitting produced nothing, return original as single exam
    if (results.MaxIndex() = 0)
        results.Push(Trim(txt))

    return results
}

; Look up a single exam against the IVU table
IVU_LookupSingle(examText) {
    global ivuDescs, ivuValues, lastMatchScore

    if (examText = "")
        return 0.00

    norm := NormalizeExamText(examText)
    inputTokens := StrSplit(norm, " ")

    stopwords := "AND,OR,THE,A,OF,FOR,IN,AT,"
    ; Common/low-value words that match many entries
    commonwords := "W,NO,CONTRAST,LEFT,RIGHT,LT,RT,VIEWS,VIEW,MORE,ORAL,IV,"

    inputClean := []
    Loop, % inputTokens.MaxIndex() {
        t := inputTokens[A_Index]
        if (t != "" && !InStr(stopwords, t . ",") && StrLen(t) > 1)
            inputClean.Push(t)
    }

    if (inputClean.MaxIndex() = 0)
        return 0.00

    bestScore := 0
    bestIdx := 0

    ; Input token weight is the same for every table row - compute once
    inputW := 0
    for i, it in inputClean
        inputW += InStr(commonwords, it . ",") ? 1 : 3

    Loop, % ivuDescs.MaxIndex() {
        idx := A_Index
        desc := ivuDescs[idx]

        descTokens := StrSplit(desc, " ")
        descClean := []
        Loop, % descTokens.MaxIndex() {
            t := descTokens[A_Index]
            if (t != "" && !InStr(stopwords, t . ",") && StrLen(t) > 1)
                descClean.Push(t)
        }

        if (descClean.MaxIndex() = 0)
            continue

        ; Weighted matching: common words = 1 point, specific words = 3 points
        weightedScore := 0
        for i, it in inputClean {
            w := InStr(commonwords, it . ",") ? 1 : 3
            for j, dt in descClean {
                if (it = dt) {
                    weightedScore += w
                    break
                }
            }
        }

        ; Score = matched weight / larger of (input weight, desc weight).
        ; inputW is loop-invariant (computed once above the Loop).
        descW := 0
        for j, dt in descClean
            descW += InStr(commonwords, dt . ",") ? 1 : 3
        maxW := (descW > inputW) ? descW : inputW

        score := (maxW > 0) ? weightedScore / maxW : 0

        if (score > bestScore) {
            bestScore := score
            bestIdx := idx
        }
    }

    if (bestScore >= 0.30 && bestIdx > 0) {
        lastMatchScore := bestScore
        return ivuValues[bestIdx]
    }

    lastMatchScore := 0
    return 0.00
}

; ============================================================
;  CALIBRATION AGAINST POWERSCRIBE'S OWN NUMBER
;
;  The problem this solves: RadTempo derives IVU by fuzzy-
;  matching the free-text EXAMINATION line of the REPORT against
;  a static CSV. PowerScribe computes its RVU from the ORDER,
;  against the site's fee schedule. Four ways those diverge, and
;  only the last one is a stale table:
;
;    1. Wrong field. The report's EXAMINATION line is prose; the
;       order carries an exact procedure code (CTAABPEWWO).
;    2. The fuzzy match has no failure mode - anything scoring
;       0.30 is accepted and logged as if it were certain.
;    3. Linked orders. PowerScribe sums every procedure on the
;       accession; SplitMultiExam guesses from prose.
;    4. Fee schedules are reissued annually and vary by site.
;
;  Nothing here reverse-engineers PowerScribe's formula, and
;  nothing reaches inside the process. PowerScribe already
;  publishes the answer: My Productivity shows a running RVU Sum.
;  Sample it across a signature and the DIFFERENCE is that one
;  study's value, in PowerScribe's units, from PowerScribe's own
;  schedule. Reports Signed is the checksum - accept the delta
;  only when exactly one report was signed, which is what keeps
;  addenda, co-signs and queue-signed reports out of the data.
;
;  Everything in here is best-effort and must fail silently. It
;  runs during dictation, so a COM error that raised AHK's modal
;  error box would put keystrokes in the wrong window - the same
;  reason the wellness card is never a MsgBox. Every entry point
;  is wrapped in try.
; ============================================================

; One pass over a window's controls: ClassNN, geometry and text.
; Both the order-data reader and the productivity reader work off
; label/value GEOMETRY rather than ClassNN, so a PowerScribe update
; that reorders controls does not break them.
ScanPSControls(winSpec) {
    out := []
    if !WinExist(winSpec)
        return out
    WinGet, ctrls, ControlList, %winSpec%
    Loop, Parse, ctrls, `n
    {
        c := A_LoopField
        if (c = "")
            continue
        ControlGetPos, cx, cy, cw, ch, %c%, %winSpec%
        ControlGetText, ct, %c%, %winSpec%
        ct := RegExReplace(Trim(ct), "\s+", " ")
        out.Push({n: c, x: cx, y: cy, w: cw, h: ch, t: ct})
    }
    return out
}

; Value of a labelled field in a control scan. Two layouts are both
; real: label and value sharing one control ("Procedure: CTAABPEWWO"),
; or two controls on the same row. Try the first, fall back to the
; nearest control to the right on the same baseline.
FieldFromScan(ctrls, label) {
    lx := -1, ly := 0, lh := 0
    n := ctrls.MaxIndex()
    if (n = "")
        return ""
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = "")
            continue
        if (RegExMatch(c.t, "i)^\s*" . label . "\s*:\s*(.*)$", fm)) {
            v := Trim(fm1)
            if (v != "")
                return v
            lx := c.x, ly := c.y, lh := c.h
            break
        }
    }
    if (lx < 0)
        return ""
    ; The value can WRAP to several lines - Description does whenever the pane
    ; is wide enough not to elide it - so its centre sits well below the
    ; label's and a centre-to-centre test misses it entirely. Pair on the
    ; label's midpoint falling inside the value's vertical SPAN instead.
    lmid := ly + lh / 2
    best := "", bestDx := 99999
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = "" || c.x <= lx)
            continue
        if (lmid < c.y - 6 || lmid > c.y + c.h + 6)
            continue
        dx := c.x - lx
        if (dx < bestDx) {
            bestDx := dx
            best := c.t
        }
    }
    return Trim(best)
}

; Keep only the controls that sit inside the named panel. A label like
; "Procedure:" appears in more than one place in PowerScribe, so the panel
; is what makes the match unambiguous. Returns the list unchanged when the
; panel is not on screen, which is the honest fallback - better a scan that
; might be ambiguous than no read at all.
ClipToPanel(ctrls, panelText) {
    n := ctrls.MaxIndex()
    if (n = "")
        return ctrls
    px := -1, py := 0, pw := 0, ph := 0
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = panelText && c.w > 40 && c.h > 40) {
            px := c.x, py := c.y, pw := c.w, ph := c.h
            break
        }
    }
    if (px < 0)
        return ctrls
    out := []
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.x >= px - 4 && c.y >= py - 4 && c.x <= px + pw + 4 && c.y <= py + ph + 4)
            out.Push(c)
    }
    if (out.MaxIndex() = "")
        return ctrls
    return out
}

; Read the Order Data pane: the procedure CODE is the prize. It is
; the key PowerScribe bills against, it is never truncated, and it is
; exact where the report's prose is not.
;
; The pane's Description is deliberately NOT trusted: it is elided in
; the UI ("CTA ABD PELVIS WO/...") and a truncated string would fuzzy-
; match worse than the report text we already have.
;
; The accession is read but never logged. It identifies a patient and
; its only use here is noticing that the same order is still open, so
; it stays in memory and never reaches disk.
ReadOrderFromPS() {
    global psProcCode, psProcDesc, psAccession
    psWin := "ahk_exe Nuance.PowerScribe360.exe"
    if !WinExist(psWin)
        return false
    got := false
    try {
        ctrls := ScanPSControls(psWin)
        ; PowerScribe has TWO controls labelled "Procedure:" - the order's,
        ; and a filter in the AutoText Manager whose value reads "All". "All"
        ; is three alphanumeric characters and passes every test a procedure
        ; code passes, so whichever one enumerated first would win and every
        ; study would be filed under a code of ALL. Narrow to the Order Data
        ; panel first; only fall back to the whole window if it is not found.
        ctrls := ClipToPanel(ctrls, "Order Data")
        code := FieldFromScan(ctrls, "Procedure")
        desc := FieldFromScan(ctrls, "Description")
        acc := FieldFromScan(ctrls, "Accession")
        code := RegExReplace(code, "[^A-Za-z0-9]", "")
        StringUpper, code, code
        ; A procedure code is a short alphanumeric token. Anything else
        ; is a mis-paired control, and a wrong code would poison the
        ; learned table - so drop it rather than guess. The stoplist is
        ; the values PowerScribe's filter comboboxes hold, which are
        ; otherwise indistinguishable from a short code.
        if (StrLen(code) < 4 || StrLen(code) > 24)
            code := ""
        if (code = "ALL" || code = "NONE" || code = "ANY" || code = "NA")
            code := ""
        if (code != "") {
            psProcCode := code
            got := true
        }
        if (desc != "" && !InStr(desc, "..."))
            psProcDesc := desc
        if (acc != "")
            psAccession := acc
    }
    return got
}
; ---- the day's total, corrected against PowerScribe ----------
; One number per date: how much to add to what the log says, so the widget
; agrees with PowerScribe. Kept out of the study log on purpose - the log
; holds per-study estimates and this is a whole-day fact about production,
; not a claim about any one study.

LoadAdjust() {
    global ADJ_FILE, adjByDate
    adjByDate := {}
    if !FileExist(ADJ_FILE)
        return
    FileRead, data, %ADJ_FILE%
    Loop, Parse, data, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 2)
            continue
        d := Trim(p[1])
        if (d = "")
            continue
        ; Last row for a date wins - a re-reading later in the day supersedes
        ; an earlier one rather than stacking on top of it.
        adjByDate[d] := p[2] + 0.0
    }
}

SaveAdjust(dateStr, adjVal, psVal) {
    global ADJ_FILE, calLastPS, calLastAt
    FormatTime, nowStamp,, yyyy-MM-dd HH:mm:ss
    if !FileExist(ADJ_FILE)
        FileAppend, Date`,Adjust`,PowerScribeTotal`,Recorded`n, %ADJ_FILE%
    FileAppend, % dateStr . "," . Format("{:.4f}", adjVal) . "," . Format("{:.4f}", psVal)
        . "," . nowStamp . "`n", %ADJ_FILE%
    calLastPS := psVal
    FormatTime, calLastAt,, HH:mm:ss
}

; What the study log alone says for today, before any correction.
TodayLoggedIVU() {
    global LOG_FILE
    if !FileExist(LOG_FILE)
        return 0.0
    FormatTime, today,, M/d/yyyy
    sum := 0.0
    FileRead, csvData, %LOG_FILE%
    Loop, Parse, csvData, `n, `r
    {
        if (A_Index = 1 || A_LoopField = "")
            continue
        p := StrSplit(A_LoopField, ",")
        if (p.MaxIndex() < 10)
            continue
        if (Trim(p[2]) = today)
            sum += p[10] + 0.0
    }
    return sum
}

TodayAdjust() {
    global adjByDate
    FormatTime, today,, M/d/yyyy
    return adjByDate.HasKey(today) ? adjByDate[today] : 0.0
}

; Push the corrected total back onto the widget and everything keyed off it.
UpdateTotals() {
    global todayIVU
    ivuRound := Format("{:.1f}", todayIVU)
    GuiControl, Main:, IVUDisplay, %ivuRound%
    UpdateGoalUI()
    UpdateTrayTip()
}

; ---- lookup, with provenance ---------------------------------
; The order's procedure code first - it is exact, and it is what
; PowerScribe bills against - then the fuzzy description match that used
; to be the only path. lastIVUSrc records which one answered, so a guess
; is never again indistinguishable from a fact.
IVU_LookupFull(examText, procCode) {
    global lastIVUSrc, lastMatchScore, lastNumExams

    lastIVUSrc := ""
    lastMatchScore := 0

    if (procCode != "") {
        byCode := FindIVUByCode(procCode)
        if (byCode > 0) {
            SplitCountOnly(examText)
            lastIVUSrc := "code"
            lastMatchScore := 1
            return byCode
        }
    }

    v := IVU_Lookup(examText)
    lastIVUSrc := (v > 0) ? "desc" : "none"
    return v
}

; Set lastNumExams from the text without touching the value.
SplitCountOnly(examText) {
    global lastNumExams
    if (examText = "") {
        lastNumExams := 1
        return
    }
    exams := SplitMultiExam(examText)
    lastNumExams := exams.MaxIndex()
    if (lastNumExams = "" || lastNumExams < 1)
        lastNumExams := 1
}

; Type PowerScribe's RVU Sum in and today's tally becomes it. Small on
; purpose: the useful act is correcting the number, and everything else
; that was here - per-code archaeology, learned values, an unreadable grid
; polled forever - was ceremony around a number that stayed wrong.
ShowCalibDialog() {
    global   ; assume-global: every v-name has to resolve (AHK v1 rule)

    Gui, Calib:Destroy
    Gui, Calib:+AlwaysOnTop +ToolWindow +HwndCalibHwnd
    Gui, Calib:Color, 0F1A2E
    Gui, Calib:Margin, 0, 0

    calW := 470
    Gui, Calib:Add, Text, x0 y0 w%calW% h3 +Background5DCAA5

    Gui, Calib:Font, s12 c5DCAA5 Bold, Segoe UI
    Gui, Calib:Add, Text, x16 y14 w420 h22 +BackgroundTrans, % Chr(0x0394) . "  Correct Today's Total"

    Gui, Calib:Font, s8 c7A9AB8 Normal, Segoe UI
    Gui, Calib:Add, Text, x16 y40 w440 h28 +BackgroundTrans
        , % "Open Dashboards " . Chr(0x2192) . " My productivity (Time Frame = Today) and read the RVU Sum."
        . "`nPowerScribe's figure is the day's real production - this makes the widget agree with it."

    calLogged := TodayLoggedIVU()
    calAdjNow := TodayAdjust()

    Gui, Calib:Font, s9 c556680 Normal, Segoe UI
    Gui, Calib:Add, Text, x16 y80 w180 h18 +BackgroundTrans, From the IVU table:
    Gui, Calib:Font, s9 cB8B8CF Normal, Segoe UI
    Gui, Calib:Add, Text, x196 y80 w80 h18 +BackgroundTrans, % Format("{:.2f}", calLogged)

    Gui, Calib:Font, s9 c556680 Normal, Segoe UI
    Gui, Calib:Add, Text, x16 y102 w180 h18 +BackgroundTrans, Showing on the widget:
    Gui, Calib:Font, s9 cFFFFFF Bold, Segoe UI
    Gui, Calib:Add, Text, x196 y102 w80 h18 +BackgroundTrans, % Format("{:.2f}", todayIVU)
    if (Abs(calAdjNow) > 0.001) {
        Gui, Calib:Font, s8 c5DCAA5 Normal, Segoe UI
        calCorrTxt := "corrected " . Format("{:+.2f}", calAdjNow)
        if (calLastAt != "")
            calCorrTxt .= " at " . calLastAt
        Gui, Calib:Add, Text, x276 y104 w180 h16 +BackgroundTrans, %calCorrTxt%
    }

    Gui, Calib:Font, s9 c7A9AB8 Normal, Segoe UI
    Gui, Calib:Add, Text, x16 y134 w180 h20 +BackgroundTrans, PowerScribe RVU Sum:
    ; Dark text on the control's own background. A custom Background on an
    ; Edit is not reliably honoured, and when it is ignored white text lands
    ; on a white field - the box looks empty while you type into it.
    Gui, Calib:Font, s11 c101020 Normal, Segoe UI
    Gui, Calib:Add, Edit, x196 y130 w90 h24 vCalibPSIn Center,
    Gui, Calib:Font, s9 cFFFFFF Normal, Segoe UI
    Gui, Calib:Add, Button, x298 y130 w86 h24 gCalibDlgApply, Apply

    Gui, Calib:Font, s8 c556680 Normal, Segoe UI
    Gui, Calib:Add, Text, x16 y168 w440 h14 +BackgroundTrans
        , Studies signed after this are added on top until you correct it again.

    calH := 230
    Gui, Calib:Font, s9 cFFFFFF Normal, Segoe UI
    Gui, Calib:Add, Button, x16 y194 w120 h26 gCalibClearDay, Clear Correction
    Gui, Calib:Add, Button, x370 y194 w86 h26 gCalibClose, Close

    ; Centre on the widget's monitor, same as the forecast dialog
    WinGetPos, cmx, cmy,,, ahk_id %MainHwnd%
    cwx := 0, cwy := 0
    SysGet, calMonCount, MonitorCount
    Loop, %calMonCount% {
        SysGet, mon, Monitor, %A_Index%
        if (cmx >= monLeft && cmx < monRight && cmy >= monTop && cmy < monBottom) {
            cwx := monLeft + ((monRight - monLeft) // 2) - (calW // 2)
            cwy := monTop + ((monBottom - monTop) // 2) - (calH // 2)
            break
        }
    }
    Gui, Calib:Show, x%cwx% y%cwy% w%calW% h%calH%, Correct Today's Total
    Gui, Main:Default
}

; A short tag for the log's IVUSrc column: "learned:6", "desc:0.42".
IVUSrcTag() {
    global lastIVUSrc, lastMatchScore
    if (lastIVUSrc = "code")
        return "code"
    if (lastIVUSrc = "desc")
        return "desc:" . Format("{:.2f}", lastMatchScore)
    return "none"
}

; True when the number on screen is a weak guess rather than a fact.
; The widget marks these, because the whole failure mode being fixed
; here is a guess that looks exactly like a measurement.
IVUIsShaky() {
    global lastIVUSrc, lastMatchScore, CAL_SHAKY_BELOW
    if (lastIVUSrc = "learned" || lastIVUSrc = "code")
        return false
    if (lastIVUSrc = "none")
        return true
    return (lastMatchScore < CAL_SHAKY_BELOW)
}
MenuCalibScale:
    calScaleOld := Format("{:.4g}", CAL_SCALE)
    InputBox, calScaleNew, IVU per RVU
        , % "How many IVU is one PowerScribe RVU?`n`n1 means they are the same unit."
        . " Leave it there unless the corrections come out at a consistent ratio."
        , , 380, 190, , , , , %calScaleOld%
    if (!ErrorLevel && calScaleNew != "" && calScaleNew + 0 > 0) {
        CAL_SCALE := calScaleNew + 0.0
        SaveSetting("IvuPerRvu", CAL_SCALE)
        NotifyAtWidget("1 RVU = " . Format("{:.4g}", CAL_SCALE) . " IVU.")
    }
return

MenuCalibReport:
    ShowCalibDialog()
return

CalibClearDay:
MenuCalibClearDay:
    FormatTime, clrDate,, M/d/yyyy
    SaveAdjust(clrDate, 0, 0)
    LoadAdjust()
    InitTodayCount()
    UpdateTotals()
    Gui, Calib:Destroy
    NotifyAtWidget("Today's correction cleared.`nBack to the table's own numbers.")
return

; Apply a PowerScribe total typed off the My Productivity dialog. It replaces
; today's tally outright: PowerScribe's figure IS the day's production, and
; anything signed after this reading gets added to it by estimate until the
; next correction.
CalibDlgApply:
    Gui, Calib:Submit, NoHide
    if (CalibPSIn + 0 <= 0) {
        NotifyAtWidget("Type the RVU Sum from My Productivity.")
        return
    }
    FormatTime, applyDate,, M/d/yyyy
    baseIVU := TodayLoggedIVU()
    psIVU := (CalibPSIn + 0.0) * CAL_SCALE
    SaveAdjust(applyDate, psIVU - baseIVU, CalibPSIn + 0.0)
    LoadAdjust()
    InitTodayCount()
    UpdateTotals()
    Gui, Calib:Destroy
    NotifyAtWidget("Today is now " . Format("{:.2f}", todayIVU) . " IVU."
        . "`nCorrected by " . Format("{:+.2f}", psIVU - baseIVU) . " against PowerScribe.")
return
CalibClose:
CalibGuiClose:
CalibGuiEscape:
    Gui, Calib:Destroy
return
; ============================================================
;  DASHBOARD GENERATOR
; ============================================================


GenerateDashboard() {
    global LOG_FILE, DASH_FILE, shiftByDate
    global CLS_MOD_KEYS, CLS_OFF_KEYS, CLS_NOISE_KEYS, CLS_ONSITE_RE
    global WIN_AM_S, WIN_AM_E, WIN_PM_S, WIN_PM_E, todayShift, forecastGoal, HOURLY_RATE
    global goalByDate, FILLER_NAME, FILLER_MATCH, GOAL_BASE, GOAL_STEP, adjByDate
    global REWARD_ENABLED, REWARD_PER_POINT, REWARD_RUNG_PTS, REWARD_STREAK_EVERY
    global REWARD_STREAK_BONUS, REWARD_WEEK_CAP, REWARD_FILE, REWARD_START
    UpdateCurrentBlock()

    if !FileExist(LOG_FILE) {
        MsgBox, 48, RadTempo, No data yet. Sign some studies first!
        return
    }

    FileRead, csvRaw, %LOG_FILE%
    StringReplace, csvEsc, csvRaw, \, \\, All
    StringReplace, csvEsc, csvEsc, `r, , All
    StringReplace, csvEsc, csvEsc, `n, \n, All
    StringReplace, csvEsc, csvEsc, ', \', All

    FileDelete, %DASH_FILE%
    f := DASH_FILE
    ; ==== BEGIN generated dashboard (tools/build_dashboard.py) ====
    a(f, "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'>")
    a(f, "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>")
    a(f, "<title>RadTempo Dashboard</title>")
    ; --- runtime data blocks (written with FileOpen to dodge %-expansion) ---
    fObj := FileOpen(f, "a", "UTF-8-RAW")
    fObj.Write("<script>const CSV_RAW='")
    fObj.Write(csvEsc)
    fObj.Write("';</script>" . "`n")
    shNow := todayShift
    StringReplace, shNow, shNow, \, \\, All
    StringReplace, shNow, shNow, ', \', All
    fObj.Write("<script>const TODAY_SHIFT='")
    fObj.Write(shNow)
    fObj.Write("';</script>" . "`n")
    shJson := "{"
    shFirst := true
    for sk, sv in shiftByDate {
        v := sv
        StringReplace, v, v, \, \\, All
        StringReplace, v, v, ", \", All
        if (!shFirst)
            shJson .= ","
        shJson .= """" . sk . """:""" . v . """"
        shFirst := false
    }
    shJson .= "}"
    fObj.Write("<script>const SHIFTS=")
    fObj.Write(shJson)
    fObj.Write(";</script>" . "`n")
    clsJson := "{mod:" . CsvToJsonArr(CLS_MOD_KEYS)
    clsJson .= ",off:" . CsvToJsonArr(CLS_OFF_KEYS)
    clsJson .= ",noise:" . CsvToJsonArr(CLS_NOISE_KEYS)
    onsiteEsc := StrReplace(CLS_ONSITE_RE, "\", "\\")
    clsJson .= ",onsite:""" . onsiteEsc . """"
    clsJson .= ",am:[" . WIN_AM_S . "," . WIN_AM_E . "],pm:[" . WIN_PM_S . "," . WIN_PM_E . "]}"
    fObj.Write("<script>const CLS=")
    fObj.Write(clsJson)
    fObj.Write(";</script>" . "`n")
    gv := (forecastGoal != "" && forecastGoal + 0 > 0) ? forecastGoal + 0 : 0
    fObj.Write("<script>const DAILY_GOAL=" . gv . ";</script>" . "`n")
    adjJson := "{"
    adjFirst := true
    for ak, av in adjByDate {
        if (Abs(av) < 0.001)
            continue
        if (!adjFirst)
            adjJson .= ","
        adjJson .= """" . ak . """:" . Format("{:.4f}", av)
        adjFirst := false
    }
    adjJson .= "}"
    fObj.Write("<script>const IVU_ADJ=")
    fObj.Write(adjJson)
    fObj.Write(";</script>" . "`n")
    fObj.Write("<script>const HOURLY_RATE=" . HOURLY_RATE . ";</script>" . "`n")
    goalJson := "{"
    goalFirst := true
    for gk, gv in goalByDate {
        if (!goalFirst)
            goalJson .= ","
        goalJson .= """" . gk . """:" . gv
        goalFirst := false
    }
    goalJson .= "}"
    fObj.Write("<script>const GOALS=")
    fObj.Write(goalJson)
    fObj.Write(";</script>" . "`n")
    fillN := FILLER_NAME
    StringReplace, fillN, fillN, \, \\, All
    StringReplace, fillN, fillN, ", \", All
    fillR := FILLER_MATCH
    StringReplace, fillR, fillR, \, \\, All
    StringReplace, fillR, fillR, ", \", All
    fObj.Write("<script>const FILLER={n:""" . fillN . """,re:""" . fillR . """,ivu:")
    fObj.Write(Format("{:.4f}", FillerIVU()) . "};</script>" . "`n")
    fObj.Write("<script>const LADDER={b:" . Format("{:.4f}", GOAL_BASE))
    fObj.Write(",s:" . Format("{:.4f}", GOAL_STEP) . "};</script>" . "`n")
    rw := "{on:" . (REWARD_ENABLED ? "1" : "0")
    rw .= ",per:" . Format("{:.4f}", REWARD_PER_POINT)
    rw .= ",rung:" . Format("{:.4f}", REWARD_RUNG_PTS)
    rw .= ",every:" . REWARD_STREAK_EVERY
    rw .= ",bonus:" . Format("{:.4f}", REWARD_STREAK_BONUS)
    rw .= ",cap:" . Format("{:.4f}", REWARD_WEEK_CAP)
    rwStart := REWARD_START
    if (StrLen(rwStart) = 8)
        rwStart := SubStr(rwStart, 1, 4) . "-" . SubStr(rwStart, 5, 2) . "-" . SubStr(rwStart, 7, 2)
    rw .= ",start:""" . rwStart . """}"
    fObj.Write("<script>const REWARD=" . rw . ";</script>" . "`n")
    coJson := "["
    coFirst := true
    if FileExist(REWARD_FILE) {
        FileRead, coData, %REWARD_FILE%
        Loop, Parse, coData, `n, `r
        {
            if (A_Index = 1 || A_LoopField = "")
                continue
            cp := StrSplit(A_LoopField, ",")
            if (cp.MaxIndex() < 2)
                continue
            cnote := (cp.MaxIndex() >= 3) ? Trim(cp[3]) : ""
            StringReplace, cnote, cnote, \, \\, All
            StringReplace, cnote, cnote, ", \", All
            if (!coFirst)
                coJson .= ","
            coJson .= "{d:""" . Trim(cp[1]) . """,a:" . (Trim(cp[2]) + 0.0)
                    . ",n:""" . cnote . """}"
            coFirst := false
        }
    }
    coJson .= "]"
    fObj.Write("<script>const CASHOUTS=" . coJson . ";</script>" . "`n")
    fObj.Close()
    a(f, "<script src='https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'></script>")
    a(f, "<style>")
    a(f, "*{margin:0;padding:0;box-sizing:border-box}")
    a(f, ":root{")
    a(f, "--pg:#0b0b16;--sf:#15152a;--sf2:#101024;--bd:#262647;--grid:#1e1e3a;")
    a(f, "--ink:#ffffff;--ink2:#b8b8cf;--mut:#7a7a99;")
    a(f, "--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;")
    a(f, "--good:#0ca30c;--warn:#fab219;--serious:#ec835a;--crit:#d03b3b;")
    a(f, "--r:14px}")
    a(f, "html{-webkit-text-size-adjust:100%}")
    a(f, "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--pg);color:var(--ink2);")
    a(f, "padding:max(14px,env(safe-area-inset-top)) clamp(12px,3vw,32px) 48px;line-height:1.45;-webkit-font-smoothing:antialiased}")
    a(f, "h1,h2,h3{color:var(--ink);font-weight:650;letter-spacing:-.01em}")
    a(f, "/* header */")
    a(f, ".hdr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 0 12px}")
    a(f, ".hdr h1{font-size:clamp(17px,4.4vw,22px)}")
    a(f, ".hdr .sp{flex:1 1 auto}")
    a(f, ".badge{display:inline-flex;align-items:center;gap:5px;background:var(--sf);border:1px solid var(--bd);")
    a(f, "color:var(--ink2);padding:5px 11px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}")
    a(f, ".badge.live{background:#0f2a20;border-color:#1d5140;color:#6fe0b0}")
    a(f, ".dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}")
    a(f, "/* filter row - one row, above everything, scopes all */")
    a(f, ".filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0 12px}")
    a(f, ".seg{display:inline-flex;background:var(--sf);border:1px solid var(--bd);border-radius:999px;padding:3px;gap:2px}")
    a(f, ".seg button{appearance:none;background:transparent;border:0;color:var(--mut);font:inherit;font-size:12px;")
    a(f, "font-weight:600;padding:8px 15px;min-height:36px;border-radius:999px;cursor:pointer;transition:.15s;white-space:nowrap}")
    a(f, ".seg button:hover{color:var(--ink2);background:#ffffff0d}")
    a(f, ".seg button[aria-pressed=true]{background:var(--s1);color:#fff}")
    a(f, ".flabel{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:1.1px;font-weight:600}")
    a(f, "/* tabs */")
    a(f, ".tabs{position:sticky;top:0;z-index:20;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;")
    a(f, "background:color-mix(in srgb,var(--pg) 88%,transparent);backdrop-filter:blur(12px);")
    a(f, "border-bottom:1px solid var(--bd);margin:0 calc(-1*clamp(12px,3vw,32px));padding:6px clamp(12px,3vw,32px)}")
    a(f, ".tabs::-webkit-scrollbar{display:none}")
    a(f, ".tabs button{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--mut);")
    a(f, "font:inherit;font-size:13px;font-weight:600;padding:11px 13px;min-height:44px;cursor:pointer;white-space:nowrap;transition:.15s}")
    a(f, ".tabs button:hover{color:var(--ink2)}")
    a(f, ".tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--s1)}")
    a(f, ".pane{display:none;animation:fade .22s ease}")
    a(f, ".pane.on{display:block}")
    a(f, "@keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}")
    a(f, "/* layout */")
    a(f, ".stit{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:1.6px;margin:26px 0 12px}")
    a(f, ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px}")
    a(f, ".row2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-top:14px}")
    a(f, ".bx{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:clamp(14px,2.2vw,20px);margin-top:14px}")
    a(f, ".bx h2{font-size:13.5px;margin-bottom:3px}")
    a(f, ".bx .desc{font-size:11px;color:var(--mut);margin-bottom:14px;line-height:1.5}")
    a(f, ".row2 .bx{margin-top:0}")
    a(f, "/* cards */")
    a(f, ".cd{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:14px 16px;transition:transform .14s,border-color .14s}")
    a(f, ".cd:hover{transform:translateY(-2px);border-color:#37376b}")
    a(f, ".cd .lb{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:1.1px;margin-bottom:6px;font-weight:600}")
    a(f, ".cd .vl{font-size:clamp(20px,5vw,25px);font-weight:750;color:var(--ink);line-height:1.1}")
    a(f, ".cd .sb{font-size:10.5px;color:var(--mut);margin-top:5px}")
    a(f, ".cd .sb b{color:var(--ink2);font-weight:650}")
    a(f, "/* hero */")
    a(f, "/* The cost of drifting, stated as loudly as the day's output. Same visual")
    a(f, "   weight as the hero number, deliberately - it is the figure meant to sting. */")
    a(f, ".costBanner{background:linear-gradient(150deg,#2f1421,#1a1020 65%);border:1px solid #5a2540;")
    a(f, "border-radius:16px;padding:clamp(15px,3vw,22px);margin-bottom:16px;display:flex;")
    a(f, "align-items:center;gap:clamp(12px,3vw,26px);flex-wrap:wrap}")
    a(f, ".costBanner .big{font-size:clamp(40px,11vw,56px);font-weight:800;color:#ff9db0;line-height:.95;letter-spacing:-.025em}")
    a(f, ".costBanner .cap{font-size:10.5px;color:#c79aa8;text-transform:uppercase;letter-spacing:1.7px;font-weight:700;margin-top:7px}")
    a(f, ".costBanner .side{flex:1 1 210px;font-size:12.5px;color:#f0ccd6;line-height:1.65}")
    a(f, ".costBanner .side b{color:#fff}")
    a(f, ".costBanner .side .win{color:#6fe0b0;font-weight:700}")
    a(f, ".hero{background:linear-gradient(150deg,#191940,#131328 60%);border:1px solid #30306a;border-radius:18px;padding:clamp(16px,3vw,24px)}")
    a(f, ".heroTop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}")
    a(f, ".heroTop .t{font-size:16px;font-weight:700;color:var(--ink)}")
    a(f, ".heroTop .s{font-size:11.5px;color:var(--mut)}")
    a(f, ".heroMain{display:flex;align-items:center;gap:clamp(14px,3vw,26px);flex-wrap:wrap}")
    a(f, ".heroNum{font-size:clamp(44px,12vw,60px);font-weight:800;color:var(--ink);line-height:.95;letter-spacing:-.03em}")
    a(f, ".heroUnit{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:1.6px;font-weight:700;margin-top:6px}")
    a(f, ".ring{flex:none}")
    a(f, ".heroSide{flex:1 1 190px;min-width:170px}")
    a(f, ".meter{height:9px;background:#0c0c1e;border:1px solid var(--bd);border-radius:999px;overflow:hidden}")
    a(f, ".meter>i{display:block;height:100%;border-radius:999px;transition:width .8s cubic-bezier(.22,1,.36,1)}")
    a(f, ".mrow{display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-top:7px}")
    a(f, "/* flow strip */")
    a(f, ".flow{display:flex;height:15px;border-radius:6px;overflow:hidden;background:#0c0c1e;border:1px solid var(--bd)}")
    a(f, ".flow>div{min-width:1px;transition:filter .12s}")
    a(f, ".flow>div:hover{filter:brightness(1.45)}")
    a(f, ".fRow{display:grid;grid-template-columns:52px 62px 1fr;align-items:center;gap:9px;margin-bottom:7px}")
    a(f, ".fRow .fDt{font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}")
    a(f, ".fRow .fId{font-size:11px;font-weight:650;text-align:right;font-variant-numeric:tabular-nums}")
    a(f, ".leg{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--mut);margin-top:12px;align-items:center}")
    a(f, ".leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}")
    a(f, "/* callouts */")
    a(f, ".alert{margin-top:14px;background:#2a1420;border:1px solid #5a2540;border-radius:11px;padding:12px 15px;font-size:12.5px;color:#f2ccd6}")
    a(f, ".alert b{color:#ff9db0}")
    a(f, ".good{margin-top:14px;background:#0f2a20;border:1px solid #1d5140;border-radius:11px;padding:12px 15px;font-size:12.5px;color:#a8e0cc}")
    a(f, ".good b{color:#6fe0b0}")
    a(f, ".ins{list-style:none;display:grid;gap:8px}")
    a(f, ".ins li{background:var(--sf2);border-left:3px solid var(--s1);border-radius:0 9px 9px 0;padding:10px 14px;font-size:12px;color:var(--ink2)}")
    a(f, ".ins li b{color:var(--ink)}")
    a(f, ".hi{color:#6fe0b0;font-weight:650}.lo{color:#ff9db0;font-weight:650}")
    a(f, "/* chips */")
    a(f, ".chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}")
    a(f, "/* label inside a colored fill: ink picked by fill luminance (all 5 modality")
    a(f, "   fills sit in the mid band, where dark ink clears 4.9-6.3:1 and white fails) */")
    a(f, ".mb{display:inline-block;padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:700;color:#0b0b16}")
    a(f, ".mb.CR{background:var(--s3)}.mb.CT{background:var(--s4)}.mb.MR{background:var(--s1)}")
    a(f, ".mb.US{background:var(--s5)}.mb.PET{background:var(--s7)}")
    a(f, "/* the bank: the one place a big number is the point, so it gets hero weight */")
    a(f, ".vault{background:linear-gradient(150deg,#0f2a20,#101a26 65%);border:1px solid #1d5140;")
    a(f, "border-radius:16px;padding:clamp(16px,3vw,24px);display:flex;align-items:center;")
    a(f, "gap:clamp(14px,3vw,28px);flex-wrap:wrap}")
    a(f, ".vault .vLb{font-size:10.5px;color:#6fe0b0;text-transform:uppercase;letter-spacing:1.7px;font-weight:700}")
    a(f, ".vault .vBig{font-size:clamp(42px,12vw,60px);font-weight:800;color:#6fe0b0;line-height:.95;")
    a(f, "letter-spacing:-.03em;margin-top:6px;font-variant-numeric:tabular-nums}")
    a(f, ".vault .vSub{font-size:12px;color:#a8e0cc;margin-top:8px}")
    a(f, ".vault .vSide{flex:1 1 210px;font-size:12.5px;color:#a8e0cc;line-height:1.7}")
    a(f, ".vault .vSide b{color:#fff}")
    a(f, ".formula{display:grid;gap:9px}")
    a(f, ".fmRow{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:baseline;")
    a(f, "background:var(--sf2);border-left:3px solid var(--s3);border-radius:0 9px 9px 0;padding:10px 14px}")
    a(f, ".fmRow .fmL{font-size:12px;color:var(--ink2)}")
    a(f, ".fmRow .fmL b{color:var(--ink)}")
    a(f, ".fmRow .fmV{font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;")
    a(f, "font-variant-numeric:tabular-nums}")
    a(f, ".fmRow.mul{border-left-color:var(--s7)}")
    a(f, ".fmRow.tot{border-left-color:var(--good);background:#101f18}")
    a(f, ".fmRow.tot .fmV{color:#6fe0b0;font-size:15px}")
    a(f, "/* filler math: an IVU deficit is not actionable, a count of studies is */")
    a(f, ".fillGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:11px}")
    a(f, ".fq{background:var(--sf2);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;")
    a(f, "display:flex;align-items:center;gap:14px}")
    a(f, ".fq .qn{font-size:clamp(30px,8vw,38px);font-weight:800;line-height:.95;letter-spacing:-.025em;")
    a(f, "flex:none;min-width:50px;text-align:center;color:var(--ink);font-variant-numeric:tabular-nums}")
    a(f, ".fq .qt{font-size:12.5px;color:var(--ink2);line-height:1.45}")
    a(f, ".fq .qt b{color:var(--ink)}")
    a(f, ".fq .qs{font-size:10.5px;color:var(--mut);margin-top:5px}")
    a(f, ".fq.dn{border-color:#5a2540;background:#1e1220}")
    a(f, ".fq.dn .qn{color:#ff9db0}")
    a(f, ".fq.up{border-color:#1d5140;background:#0f2018}")
    a(f, ".fq.up .qn{color:#6fe0b0}")
    a(f, ".cred{color:#6fe0b0;font-weight:650;white-space:nowrap}")
    a(f, "/* streak */")
    a(f, ".streaks{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:11px}")
    a(f, ".stk{background:var(--sf2);border:1px solid var(--bd);border-radius:11px;padding:13px 14px;text-align:center}")
    a(f, ".stk .n{font-size:26px;font-weight:800;color:var(--ink);line-height:1}")
    a(f, ".stk .l{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:1px;margin-top:6px;font-weight:600}")
    a(f, ".stk .e{font-size:19px}")
    a(f, "/* charts + tables */")
    a(f, ".cwrap{position:relative;height:min(46vw,270px);min-height:190px}")
    a(f, ".cwrap.tall{height:min(60vw,320px)}")
    a(f, ".tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}")
    a(f, "table{width:100%;border-collapse:collapse;font-size:12px;min-width:420px}")
    a(f, "th{text-align:left;color:var(--mut);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--bd);")
    a(f, "font-size:10px;letter-spacing:.9px;text-transform:uppercase;white-space:nowrap}")
    a(f, "td{padding:8px 10px;border-bottom:1px solid #16162e;font-variant-numeric:tabular-nums;white-space:nowrap}")
    a(f, "td:first-child{white-space:normal;min-width:130px}")
    a(f, "tbody tr:hover td{background:#1b1b38}")
    a(f, ".up{color:#6fe0b0}.dn{color:#ff9db0}.nt{color:var(--mut)}")
    a(f, ".tot{color:#a9c8f5;font-weight:700}")
    a(f, "select{background:var(--sf2);color:var(--ink2);border:1px solid var(--bd);padding:9px 12px;border-radius:9px;")
    a(f, "font:inherit;font-size:12.5px;min-height:40px;max-width:100%;margin-bottom:12px}")
    a(f, ".tgl{appearance:none;background:var(--sf2);border:1px solid var(--bd);color:var(--mut);font:inherit;font-size:11px;")
    a(f, "font-weight:600;padding:6px 11px;min-height:32px;border-radius:8px;cursor:pointer;margin-bottom:10px}")
    a(f, ".tgl:hover{color:var(--ink2);border-color:#37376b}")
    a(f, ".tv{display:none;margin-top:6px}.tv.on{display:block}")
    a(f, ".empty{font-size:13px;color:var(--mut);padding:10px 0}")
    a(f, "@media(max-width:560px){.fRow{grid-template-columns:44px 54px 1fr;gap:7px}")
    a(f, "table{font-size:11.5px}.stit{margin:20px 0 10px}}")
    a(f, "@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}")
    a(f, "</style></head><body>")
    a(f, "<div class='hdr'><h1>RadTempo</h1><span class='sp'></span>")
    a(f, "<span class='badge' id='bDr'></span><span class='badge live' id='bSh' style='display:none'><i class='dot'></i><span id='bShT'></span></span></div>")
    a(f, "<div class='filters'><span class='flabel'>Range</span><div class='seg' id='rng'>")
    a(f, "<button data-d='7'>7d</button><button data-d='30'>30d</button><button data-d='90'>90d</button><button data-d='0'>All</button></div></div>")
    a(f, "<div class='tabs' role='tablist' id='tabs'>")
    a(f, "<button role='tab' data-p='today' aria-selected='true'>Today</button>")
    a(f, "<button role='tab' data-p='focus' aria-selected='false'>Focus</button>")
    a(f, "<button role='tab' data-p='rhythm' aria-selected='false'>Rhythm</button>")
    a(f, "<button role='tab' data-p='bank' aria-selected='false'>Bank</button>")
    a(f, "<button role='tab' data-p='shifts' aria-selected='false'>Shifts</button>")
    a(f, "<button role='tab' data-p='exams' aria-selected='false'>Exams</button>")
    a(f, "<button role='tab' data-p='log' aria-selected='false'>Log</button></div>")
    a(f, "")
    a(f, "<section class='pane on' id='p-today'><div id='heroWrap'></div>")
    a(f, "<div class='stit'>Today at a glance</div><div class='grid' id='tGrid'></div>")
    a(f, "<div class='bx' id='bxTFlow' style='display:none'><h2>Today&#39;s flow</h2>")
    a(f, "<div class='desc'>Green is reading, red is an idle gap between studies. Long breaks are omitted.</div>")
    a(f, "<div id='tFlow'></div><div class='leg'><span><i style='background:var(--good)'></i>reading</span>")
    a(f, "<span><i style='background:var(--crit)'></i>idle gap</span><span><i style='background:#0c0c1e'></i>break omitted</span></div>")
    a(f, "<div id='tAlert'></div></div>")
    a(f, "<div class='bx' id='bxFill' style='display:none'><h2 id='fillH'>As a unit</h2>")
    a(f, "<div class='desc' id='fillD'></div>")
    a(f, "<div class='fillGrid' id='fillGrid'></div>")
    a(f, "<div id='fillNote' style='font-size:12.5px;color:var(--ink2);line-height:1.65;margin-top:13px'></div></div>")
    a(f, "<div id='tNotes'></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-focus'>")
    a(f, "<div class='costBanner' id='costBanner' style='display:none'></div>")
    a(f, "<div class='bx' id='bxGoal' style='display:none'><h2>Daily goal &mdash; consistency</h2>")
    a(f, "<div class='desc'>Only days you actually committed to a goal are counted. Bars are the IVU you actually")
    a(f, "delivered and the dash is that day&#39;s goal &mdash; on one scale, so a tall bar that misses is visibly more")
    a(f, "work than a short one that clears. &#10003; / &#10007; on the date marks the outcome.</div>")
    a(f, "<div class='streaks' id='goalStk' style='margin-bottom:14px'></div>")
    a(f, "<div id='goalNote' style='font-size:12.5px;color:var(--ink2);line-height:1.65;margin-bottom:14px'></div>")
    a(f, "<button class='tgl' data-tv='tvGoal'>Table view</button>")
    a(f, "<div class='cwrap'><canvas id='chGoal'></canvas></div>")
    a(f, "<div class='tv' id='tvGoal'></div></div>")
    a(f, "<div class='stit'>Focus scoreboard</div><div class='streaks' id='fStreaks'></div>")
    a(f, "<div class='bx' id='bxPar' style='display:none'><h2>Par</h2>")
    a(f, "<div class='desc'>Par is your median <b>engaged</b> time for that exam type, so you beat it by not drifting &mdash; never by reading faster. Time spent away from the keyboard doesn&#39;t count against you.</div>")
    a(f, "<div id='parSum' style='font-size:13px;color:var(--ink2);line-height:1.7;margin-bottom:13px'></div>")
    a(f, "<div class='tblwrap'><table id='tPar'><thead><tr><th>Exam</th><th>Bets</th><th>Under par</th>")
    a(f, "<th>Win rate</th><th>Typical vs par</th></tr></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx'><h2>The prize</h2><div class='desc'>What fragmentation is costing you, measured from your own log</div>")
    a(f, "<div id='fHead' style='font-size:13px;color:var(--ink2);line-height:1.65'></div></div>")
    a(f, "<div class='bx'><h2>Where each day goes</h2><div class='desc'>One strip per worked day. Tighter, greener strips mean more back-to-back reading.</div>")
    a(f, "<div id='fStrips'></div><div class='leg'><span><i style='background:var(--good)'></i>reading</span>")
    a(f, "<span><i style='background:var(--crit)'></i>idle gap</span><span><i style='background:#0c0c1e'></i>break omitted</span></div></div>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>Idle minutes per day</h2><div class='desc'>Time lost to gaps of 2-30 min between studies</div>")
    a(f, "<button class='tgl' data-tv='tvIdle'>Table view</button><div class='cwrap'><canvas id='chIdle'></canvas></div>")
    a(f, "<div class='tv' id='tvIdle'></div></div>")
    a(f, "<div class='bx'><h2>Focus score per day</h2><div class='desc'>Share of engaged time actually spent reading</div>")
    a(f, "<button class='tgl' data-tv='tvFoc'>Table view</button><div class='cwrap'><canvas id='chFoc'></canvas></div>")
    a(f, "<div class='tv' id='tvFoc'></div></div></div>")
    a(f, "<div class='bx'><h2>The multitask tax</h2><div class='desc'>Measured restart cost of interruptions</div>")
    a(f, "<div id='fTax' style='font-size:12.5px;line-height:1.7'></div></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-rhythm'>")
    a(f, "<div id='rhEmpty' class='empty' style='display:none'>Not enough worked days in this range to read a pattern &mdash; needs at least 5.</div>")
    a(f, "<div id='rhBody' style='display:none'>")
    a(f, "<div class='stit'>Your clock</div><div class='streaks' id='rhStk'></div>")
    a(f, "<div class='bx'><h2 id='rhQ'>Does starting earlier get you out earlier?</h2>")
    a(f, "<div class='desc'>One dot per worked day: when the first study opened, against when the last one was signed.")
    a(f, "The dashed line is the fitted trend. Association, not proof &mdash; the day&#39;s workload isn&#39;t held constant.</div>")
    a(f, "<div id='rhVerdict' style='font-size:13px;color:var(--ink2);line-height:1.7;margin-bottom:13px'></div>")
    a(f, "<button class='tgl' data-tv='tvRhFit'>Table view</button>")
    a(f, "<div class='cwrap tall'><canvas id='chRhFit'></canvas></div>")
    a(f, "<div class='tv' id='tvRhFit'></div></div>")
    a(f, "<div class='bx'><h2>Where each day sat on the clock</h2>")
    a(f, "<div class='desc' id='rhRibD'>First study open to last study signed, most recent day at the top.</div>")
    a(f, "<div class='leg'><span style='color:var(--good)'>&#10003; goal hit</span>")
    a(f, "<span style='color:var(--crit)'>&#10007; goal missed</span>")
    a(f, "<span>no mark &mdash; no goal was set that day</span></div>")
    a(f, "<button class='tgl' data-tv='tvRhRib'>Table view</button>")
    a(f, "<div class='cwrap' style='height:min(150vw,560px)'><canvas id='chRhRib'></canvas></div>")
    a(f, "<div class='tv' id='tvRhRib'></div></div>")
    a(f, "<div class='bx'><h2>A typical day, by weekday</h2>")
    a(f, "<div class='desc'>Median start and median finish for each weekday you work. The bar is the middle of your day.</div>")
    a(f, "<button class='tgl' data-tv='tvRhDow'>Table view</button>")
    a(f, "<div class='cwrap tall'><canvas id='chRhDow'></canvas></div>")
    a(f, "<div class='tv' id='tvRhDow'></div></div>")
    a(f, "<div class='bx'><h2>What the start time is worth</h2>")
    a(f, "<div class='desc'>How output, day length and drifting track your start time across this range</div>")
    a(f, "<div id='rhNotes' style='font-size:12.5px;line-height:1.75'></div></div></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-bank'>")
    a(f, "<div id='bkOff' class='empty' style='display:none'>Rewards are switched off.</div>")
    a(f, "<div id='bkBody' style='display:none'>")
    a(f, "<div class='vault'><div>")
    a(f, "<div class='vLb'>In the bank</div><div class='vBig' id='bkBal'>$0</div>")
    a(f, "<div class='vSub' id='bkSub'></div></div>")
    a(f, "<div class='vSide' id='bkSide'></div></div>")
    a(f, "<div class='stit'>Today</div><div class='grid' id='bkToday'></div>")
    a(f, "<div class='bx'><h2>How it is worked out</h2>")
    a(f, "<div class='desc'>Two components, and the mix is the point &mdash; focus scales what the volume is worth,")
    a(f, "so neither one alone pays much.</div>")
    a(f, "<div id='bkFormula' class='formula'></div>")
    a(f, "<div id='bkNote' style='font-size:12.5px;color:var(--ink2);line-height:1.7;margin-top:14px'></div></div>")
    a(f, "<div class='bx'><h2>Earned per day</h2>")
    a(f, "<div class='desc' id='bkChartD'>What each day paid, split into the par half and the goal half</div>")
    a(f, "<button class='tgl' data-tv='tvBank'>Table view</button>")
    a(f, "<div class='cwrap tall'><canvas id='chBank'></canvas></div>")
    a(f, "<div class='tv' id='tvBank'></div></div>")
    a(f, "<div class='bx' id='bxCash' style='display:none'><h2>Cashed out</h2>")
    a(f, "<div class='desc'>Withdrawals you recorded from Tray &rarr; Rewards &rarr; Cash Out</div>")
    a(f, "<div id='bkCash'></div></div></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-shifts'><div id='shEmpty' class='empty' style='display:none'>No shift data in this range.</div>")
    a(f, "<div id='shBody' style='display:none'>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>IVU per block</h2><div class='desc'>Half-day and call blocks, attributed by sign time. * marks on-site.</div>")
    a(f, "<button class='tgl' data-tv='tvShift'>Table view</button><div class='cwrap tall'><canvas id='chShift'></canvas></div>")
    a(f, "<div class='tv' id='tvShift'></div></div>")
    a(f, "<div class='bx'><h2>IVU by weekday</h2><div class='desc'>Average IVU per worked day</div>")
    a(f, "<button class='tgl' data-tv='tvDow'>Table view</button><div class='cwrap tall'><canvas id='chDow'></canvas></div>")
    a(f, "<div class='tv' id='tvDow'></div></div></div>")
    a(f, "<div class='bx'><h2>Block breakdown</h2><div class='desc'>Volume, IVU and scheduled hours per block type</div>")
    a(f, "<div class='tblwrap'><table id='tSh'><thead><tr><th>Block</th><th>Blocks</th><th>Studies</th><th>Stud/blk</th>")
    a(f, "<th>Total IVU</th><th>IVU/blk</th><th>IVU/hr</th><th>Hrs</th><th>Site</th></tr></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx' id='bxIns' style='display:none'><h2>Insights</h2><div class='desc'>Patterns detected in your history</div><ul class='ins' id='insList'></ul></div>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>Modality mix by block</h2><div class='desc'>Average studies per block, split by modality</div>")
    a(f, "<div class='cwrap tall'><canvas id='chMix'></canvas></div></div>")
    a(f, "<div class='bx'><h2>IVU through the day</h2><div class='desc'>Average cumulative IVU by hour - the shape of each block</div>")
    a(f, "<div class='cwrap tall'><canvas id='chCum'></canvas></div></div></div>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>Output across a work stretch</h2><div class='desc'>IVU per day by position in a consecutive-day run</div>")
    a(f, "<div class='cwrap'><canvas id='chFatI'></canvas></div></div>")
    a(f, "<div class='bx'><h2>Read time across a work stretch</h2><div class='desc'>Average seconds per study by position in the run</div>")
    a(f, "<div class='cwrap'><canvas id='chFatS'></canvas></div></div></div>")
    a(f, "<div class='bx'><h2>Block trend over time</h2><div class='desc'>IVU per block for one block type</div>")
    a(f, "<select id='shSel'></select><div class='cwrap'><canvas id='chShTrend'></canvas></div></div>")
    a(f, "<div class='bx' id='bxMod' style='display:none'><h2>Modifier impact</h2>")
    a(f, "<div class='desc'>Same block type, with vs without a concurrent modifier. Positive means more output with it.</div>")
    a(f, "<div class='tblwrap'><table id='tMod'><thead><tr><th>Modifier</th><th>Blocks with</th><th>IVU/blk with</th>")
    a(f, "<th>IVU/blk without</th><th>Delta</th></tr></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx' id='bxXS' style='display:none'><h2>Same exam, different block</h2>")
    a(f, "<div class='desc'>Average read time for common exams by block context - reveals interruption cost</div>")
    a(f, "<div class='tblwrap'><table id='tXS'><thead></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx' id='bxFc' style='display:none'><h2>Next 14 days</h2>")
    a(f, "<div class='desc'>From QGenda - per-block typicals with measured modifier deltas applied</div>")
    a(f, "<div id='fcSum' style='font-size:13px;color:#a9c8f5;font-weight:650;margin-bottom:12px'></div>")
    a(f, "<div class='tblwrap'><table id='tFc'><thead><tr><th>Date</th><th>Day</th><th>Blocks</th>")
    a(f, "<th>Exp. studies</th><th>Exp. IVU</th></tr></thead><tbody></tbody></table></div></div></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-exams'><div class='stit'>Modality averages</div><div class='grid' id='mc'></div>")
    a(f, "<div class='bx'><h2>IVU efficiency by modality</h2><div class='desc'>IVU generated per minute of active reading</div>")
    a(f, "<button class='tgl' data-tv='tvEff'>Table view</button><div class='cwrap tall'><canvas id='chIVUEff'></canvas></div>")
    a(f, "<div class='tv' id='tvEff'></div></div>")
    a(f, "<div class='bx'><h2>Average time by study type</h2>")
    a(f, "<div class='desc'>Grouped by exam name. Filter by modality, tap a column header to sort, tap a row for its trend.</div>")
    a(f, "<select id='stModFilter'><option value='ALL'>All modalities</option><option value='CR'>X-Ray (CR)</option>")
    a(f, "<option value='CT'>CT</option><option value='MR'>MRI</option><option value='US'>Ultrasound</option><option value='PET'>PET/CT</option></select>")
    a(f, "<div class='tblwrap'><table id='tST'><thead><tr><th data-s='0'>Study type</th><th data-s='1'>Mod</th><th data-s='2'>Count</th>")
    a(f, "<th data-s='3'>Avg time</th><th data-s='4'>Avg IVU</th><th data-s='5'>IVU/min</th></tr></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx'><h2>Study type trend</h2><div class='desc'>How your reading time changes over sessions</div>")
    a(f, "<select id='stSel'></select><div class='cwrap tall'><canvas id='chSTrend'></canvas></div></div></section>")
    a(f, "")
    a(f, "<section class='pane' id='p-log'>")
    a(f, "<div class='stit'>Records</div><div class='grid' id='rc'></div>")
    a(f, "<div class='bx'><h2>Daily volume by modality</h2><div class='desc'>Studies signed per day</div>")
    a(f, "<div class='cwrap tall'><canvas id='chVol'></canvas></div></div>")
    a(f, "<div class='bx'><h2>Daily IVU by modality</h2><div class='desc'>IVU produced per day</div>")
    a(f, "<div class='cwrap tall'><canvas id='chIVU'></canvas></div></div>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>Active vs on-clock hours</h2><div class='desc'>Gaps over 30 min excluded from on-clock</div>")
    a(f, "<div class='cwrap'><canvas id='chEff'></canvas></div></div>")
    a(f, "<div class='bx'><h2>Studies per hour of day</h2><div class='desc'>When you read most - your peak hour is highlighted</div>")
    a(f, "<div class='cwrap'><canvas id='chHr'></canvas></div></div></div>")
    a(f, "<div class='row2'>")
    a(f, "<div class='bx'><h2>Studies per week</h2><div class='desc'>Volume by ISO week</div>")
    a(f, "<div class='cwrap'><canvas id='chWkN'></canvas></div></div>")
    a(f, "<div class='bx'><h2>Active hours per week</h2><div class='desc'>Reading time by ISO week</div>")
    a(f, "<div class='cwrap'><canvas id='chWkH'></canvas></div></div></div>")
    a(f, "<div class='bx'><h2>Daily log</h2><div class='desc'>Every worked day in range</div>")
    a(f, "<div class='tblwrap'><table id='tDH'><thead><tr><th>Date</th><th>Day</th><th>Studies</th><th>Active</th>")
    a(f, "<th>On-clock</th><th>Idle</th><th>Idle cost</th><th>Focus</th><th>IVU</th></tr></thead><tbody></tbody></table></div></div>")
    a(f, "<div class='bx'><h2>Recent studies</h2><div class='desc'>Last 40 signed</div>")
    a(f, "<div class='tblwrap'><table id='tR'><thead><tr><th>Time</th><th>Mod</th><th>Exam</th><th>Duration</th>")
    a(f, "<th>vs avg</th><th>IVU</th></tr></thead><tbody></tbody></table></div></div></section>")
    a(f, "<script>")
    a(f, "try{")
    a(f, "if(typeof CSV_RAW==='undefined'){document.body.innerHTML='<h2 style=""color:#d03b3b;margin:40px"">ERROR: CSV data not loaded</h2>';throw 0;}")
    a(f, "if(typeof Chart==='undefined'){document.body.innerHTML='<h2 style=""color:#d03b3b;margin:40px"">ERROR: Chart.js not loaded. Check internet connection.</h2>';throw 0;}")
    a(f, "var HASCLS=(typeof CLS!=='undefined'),HASSH=(typeof SHIFTS!=='undefined');")
    a(f, "var GOAL=(typeof DAILY_GOAL!=='undefined'&&+DAILY_GOAL>0)?+DAILY_GOAL:0;")
    a(f, "/* Hourly rate prices TIME only - idle gaps, engaged hours, hours reclaimed.")
    a(f, "   Deliberately never priced per study: $/study would reward reading faster. */")
    a(f, "var RATE=(typeof HOURLY_RATE!=='undefined'&&+HOURLY_RATE>0)?+HOURLY_RATE:0;")
    a(f, "var GOALMAP=(typeof GOALS!=='undefined'&&GOALS)?GOALS:{};")
    a(f, "/* ---- palette (validated: see tools/palette_check) ---- */")
    a(f, "var SF='#15152a',GRID='#1e1e3a',MUT='#7a7a99';")
    a(f, "var MC={CR:'#199e70',CT:'#c98500',MR:'#3987e5',US:'#d55181',PET:'#9085e9'};")
    a(f, "var MN={CR:'X-Ray',CT:'CT',MR:'MRI',US:'Ultrasound',PET:'PET/CT'};")
    a(f, "var SPAL=['#3987e5','#d95926','#199e70','#c98500','#d55181','#008300','#9085e9','#e66767'];")
    a(f, "var GOODC='#0ca30c',CRITC='#d03b3b',WARNC='#fab219';")
    a(f, "/* ---- helpers ---- */")
    a(f, "function esc(s){return String(s==null?'':s).replace(/[&<>""']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','""':'&quot;',""'"":'&#39;'}[c];});}")
    a(f, "function ft(s){var m=Math.floor(s/60),c=Math.round(s%60);return m+':'+String(c).padStart(2,'0');}")
    a(f, "function fh(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>0?h+'h '+m+'m':m+'m';}")
    a(f, "function fhr(s){return Math.round(s/360)/10;}")
    a(f, "function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}")
    a(f, "function mdyOf(d){return (d.getMonth()+1)+'/'+d.getDate()+'/'+d.getFullYear();}")
    a(f, "function el(id){return document.getElementById(id);}")
    a(f, "function usd(n){var v=Math.round(n);return '$'+String(v).replace(/\B(?=(\d{3})+(?!\d))/g,',');}")
    a(f, "function moneyFor(sec){return RATE>0?usd(sec/3600*RATE):'';}")
    a(f, "function tbl(head,rows){var h='<div class=""tblwrap""><table><thead><tr>';head.forEach(function(x){h+='<th>'+esc(x)+'</th>';});")
    a(f, "h+='</tr></thead><tbody>';rows.forEach(function(r){h+='<tr>';r.forEach(function(c){h+='<td>'+esc(c)+'</td>';});h+='</tr>';});")
    a(f, "return h+'</tbody></table></div>';}")
    a(f, "/* ---- shift attribution (mirrors the AHK engine) ---- */")
    a(f, "function evClean(t){return t.replace(/\s*\[[^\]]*\]/g,'').replace(/\*?\s*swap.*$/i,'').trim();}")
    a(f, "function evClass(t){var u=t.toUpperCase();if(CLS.noise.some(function(k){return u.includes(k);}))return 'N';")
    a(f, "if(CLS.off.some(function(k){return u.includes(k);}))return 'O';")
    a(f, "if(CLS.mod.some(function(k){return u.includes(k);}))return 'M';return 'P';}")
    a(f, "function evWin(t){var m=t.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i);")
    a(f, "var hf=function(hh,mm,ap){return (+hh%12)+(ap.toLowerCase()==='p'?12:0)+(mm?+mm/60:0);};")
    a(f, "if(m){var s=hf(m[1],m[2],m[3]),e=hf(m[4],m[5],m[6]);if(e<=s)e+=24;return[s,e,true];}")
    a(f, "if(/\bAM\b/i.test(t))return[CLS.am[0],CLS.am[1],true];")
    a(f, "if(/\bPM\b/i.test(t))return[CLS.pm[0],CLS.pm[1],true];return[0,24,false];}")
    a(f, "var onRe=!HASCLS?null:CLS.onsite?new RegExp(CLS.onsite,'i'):/(?!)/;")
    a(f, "function dayPlan(raw){var P=[],M=[],ex=false;(raw||'').split(' / ').forEach(function(tok){var c=evClean(tok);if(!c)return;")
    a(f, "var k=evClass(c),w=evWin(c);")
    a(f, "if(k==='P')P.push({name:c,s:w[0],e:w[1],w:w[2],on:onRe.test(c)});")
    a(f, "else if(k==='M')M.push({name:c,s:w[0],e:w[1],w:w[2]});")
    a(f, "else if(k==='N'&&c.toUpperCase().includes('EXTRA HOURS'))ex=true;});")
    a(f, "if(!P.length&&ex)P.push({name:'Extra Hours',s:0,e:24,w:false,on:false});return[P,M];}")
    a(f, "function attrib(raw,t){var pm=dayPlan(raw),P=pm[0],M=pm[1];if(!P.length)return['Unscheduled',''];")
    a(f, "var c=P.filter(function(p){return p.s<=t&&t<p.e;}),b;")
    a(f, "if(c.length)b=c.sort(function(a,x){return (a.e-a.s)-(x.e-x.s)||x.s-a.s;})[0];")
    a(f, "else b=P.slice().sort(function(a,x){return Math.min(Math.abs(t-a.s),Math.abs(t-a.e))-Math.min(Math.abs(t-x.s),Math.abs(t-x.e))||x.s-a.s;})[0];")
    a(f, "var ex=M.filter(function(m){return !m.w||(m.s<=t&&t<m.e);}).map(function(m){return m.name;}).join(' + ');")
    a(f, "return[b.name,ex];}")
    a(f, "function modBase(m){return m.replace(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i,'').replace(/[:\s]+$/,'').trim();}")
    a(f, "/* ---- parse ---- */")
    a(f, "var D=CSV_RAW.trim().split('\n').slice(1).filter(function(l){return l.trim();}).map(function(l){")
    a(f, "var v=l.split(','),ex=(v[8]||'').trim(),raw=v[1]||'',dt=raw;")
    a(f, "if(raw.match(/^\d{1,2}\//)){var p=raw.split('/');dt=p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');}")
    a(f, "var tm=(v[0]||'').match(/\s(\d{1,2}):(\d{2})$/),tt=tm?(+tm[1]+ +tm[2]/60):(+v[3]+0.5);")
    a(f, "var sh=(v[10]||'').trim(),xr=(v[11]||'').trim();")
    a(f, "if(HASCLS&&HASSH&&SHIFTS[raw]){var at=attrib(SHIFTS[raw],tt);sh=at[0];xr=at[1];}")
    a(f, "/* col 13 (ActiveSec): physically-active seconds measured during the study.")
    a(f, "   -1 means ""not measured"" - legacy rows, or tracking switched off. */")
    a(f, "var av=(v[12]===undefined||String(v[12]).trim()==='')?-1:(parseInt(v[12],10));")
    a(f, "if(isNaN(av))av=-1;")
    a(f, "var pv=(v[13]===undefined||String(v[13]).trim()==='')?0:(parseInt(v[13],10)||0);")
    a(f, "/* cols 15/16 (ProcCode, IVUSrc): where the row's IVU actually came from.")
    a(f, "   ""learned:n"" is PowerScribe's own figure for that procedure code, ""code"" an")
    a(f, "   exact table hit, ""desc:0.42"" the old fuzzy match against the report's prose")
    a(f, "   and how well it scored. Blank on every row written before calibration")
    a(f, "   existed - those are unknown, not good. */")
    a(f, "var sv=(v[15]||'').trim();")
    a(f, "return{ts:v[0],date:dt,dRaw:raw,day:v[2],hr:+v[3],tt:tt,sec:+v[4],fmt:v[5],mod:v[6],exam:ex,")
    a(f, "ivu:parseFloat(v[9])||0,shift:(sh==='Unscheduled'?'':sh),extras:xr,act:av,par:pv,")
    a(f, "code:(v[14]||'').trim(),src:sv,firm:(sv.indexOf('learned')===0||sv==='code')};});")
    a(f, "if(!D.length){document.body.innerHTML='<h2 style=""color:#7a7a99;text-align:center;margin:100px"">No data yet</h2>';throw 0;}")
    a(f, "var TODAY=ymd(new Date()),TRAW=mdyOf(new Date());")
    a(f, "/* ---- day totals corrected against PowerScribe ----")
    a(f, "   PowerScribe's RVU Sum for a day is the authoritative production figure;")
    a(f, "   the log's IVU column is a per-study estimate off a table that drifts. When")
    a(f, "   a day has been corrected on the widget, the same correction has to apply")
    a(f, "   here or the dashboard quietly contradicts the number you were looking at -")
    a(f, "   which is the original bug, one layer down. Keyed on the raw M/d/yyyy date,")
    a(f, "   the same key the widget writes. */")
    a(f, "var IADJ=(typeof IVU_ADJ!=='undefined'&&IVU_ADJ)?IVU_ADJ:{};")
    a(f, "function dayAdj(k){return +(IADJ[k]||0);}")
    a(f, "function sumIvu(dd){if(!dd||!dd.length)return 0;")
    a(f, "var v=dd.filter(function(x){return x.ivu>0;}).reduce(function(a,x){return a+x.ivu;},0)")
    a(f, "+dayAdj(dd[0].dRaw);return v>0?v:0;}")
    a(f, "/* ---- the filler exam ----")
    a(f, "   When the assigned worklist runs dry there is one exam type that gets read to")
    a(f, "   top the day up. ""3.4 IVU short"" is not a number you can act on; ""3 more lung")
    a(f, "   screenings"" is, so every deficit and every stretch of lost time is also")
    a(f, "   quoted in that unit.")
    a(f, "   Calibrated from the log FIRST - the IVU actually recorded and the engaged")
    a(f, "   time actually measured - because that is ground truth for this reader. The")
    a(f, "   value emitted from the IVU table is only the fallback for someone who has")
    a(f, "   never read one. */")
    a(f, "var FILL=(typeof FILLER!=='undefined'&&FILLER&&FILLER.re)?FILLER:null;")
    a(f, "var LAD=(typeof LADDER!=='undefined'&&LADDER&&+LADDER.s>0)?{b:+LADDER.b,s:+LADDER.s}:null;")
    a(f, "function med(a){if(!a.length)return 0;var s=a.slice().sort(function(x,y){return x-y;});")
    a(f, "var m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}")
    a(f, "function r1(n){return Math.round(n*10)/10;}")
    a(f, "/* Lowest rung strictly above v. Finishing between two rungs pays the same as")
    a(f, "   the rung below, so the rung - not the raw number - is what is worth chasing. */")
    a(f, "function nextRung(v){if(!LAD)return 0;if(v<LAD.b)return LAD.b;")
    a(f, "var r=LAD.b+(Math.floor((v-LAD.b)/LAD.s)+1)*LAD.s;while(r<=v+1e-3)r+=LAD.s;return r1(r);}")
    a(f, "/* Daily credits at an IVU total: one step past the floor is one credit, which")
    a(f, "   is one hour. Floored, because a total between rungs pays the rung below. */")
    a(f, "function credits(v){return LAD?Math.max(0,Math.floor((v-LAD.b)/LAD.s+1e-4)):0;}")
    a(f, "function nCred(c){return c+(c===1?' credit':' credits');}")
    a(f, "var FSTAT=(function(){")
    a(f, "if(!FILL)return null;")
    a(f, "var re;try{re=new RegExp(FILL.re,'i');}catch(e){return null;}")
    a(f, "var hits=D.filter(function(d){return d.exam&&re.test(d.exam);});")
    a(f, "/* median, not mean: one linked/mis-parsed row would otherwise move both */")
    a(f, "var iv=med(hits.map(function(d){return d.ivu;}).filter(function(v){return v>0;}));")
    a(f, "var sec=med(hits.map(function(d){return d.act>0?d.act:d.sec;}).filter(function(v){return v>0;}));")
    a(f, "if(!(iv>0))iv=+FILL.ivu||0;")
    a(f, "if(!(iv>0))return null;              /* nothing to denominate in - stay quiet */")
    a(f, "return{name:FILL.n||'filler study',ivu:r1(iv),sec:sec,n:hits.length};})();")
    a(f, "/* ---- focus engine ---- */")
    a(f, "var FMICRO=120,FBREAK=1800;")
    a(f, "function focusDay(rows){var iv=rows.map(function(d){var e=new Date(d.ts).getTime();return{s:e-d.sec*1000,e:e,sec:d.sec};})")
    a(f, ".filter(function(x){return x.e>0;}).sort(function(a,b){return a.s-b.s;});")
    a(f, "var segs=[],active=0,idle=0,gc=0,lng=0;")
    a(f, "/* In-study idle: measured seconds inside a study with no physical input.")
    a(f, "   Only counted for rows that actually carry a measurement (act >= 0). */")
    a(f, "var inIdle=0,inMeas=0;")
    a(f, "rows.forEach(function(d){if(d.act>=0){inMeas+=d.sec;var g=d.sec-d.act;if(g>0)inIdle+=g;}});")
    a(f, "if(!iv.length)return{active:0,idle:0,gc:0,lng:0,segs:segs,inIdle:inIdle,inMeas:inMeas};")
    a(f, "var ce=iv[0].e;active+=iv[0].sec;segs.push({t:'r',s:iv[0].sec});")
    a(f, "for(var i=1;i<iv.length;i++){var gm=iv[i].s-ce;")
    a(f, "if(gm>0){var g=gm/1000;")
    a(f, "if(g>=FBREAK)segs.push({t:'b',s:g});")
    a(f, "else if(g>FMICRO){idle+=g;gc++;if(g>lng)lng=g;segs.push({t:'i',s:g});}")
    a(f, "else segs.push({t:'m',s:g});}")
    a(f, "active+=iv[i].sec;segs.push({t:'r',s:iv[i].sec});if(iv[i].e>ce)ce=iv[i].e;}")
    a(f, "return{active:active,idle:idle,gc:gc,lng:lng,segs:segs,inIdle:inIdle,inMeas:inMeas};}")
    a(f, "function flowStrip(segs){if(!segs.length)return '';")
    a(f, "var cap=function(x){return x.t==='b'?Math.min(x.s,240):x.s;};")
    a(f, "var tot=segs.reduce(function(a,x){return a+cap(x);},0)||1;")
    a(f, "var h=segs.map(function(x){var w=cap(x)/tot*100;")
    a(f, "var col=x.t==='r'?GOODC:x.t==='i'?CRITC:x.t==='m'?'#0d5c3f':'#0c0c1e';")
    a(f, "var tip=(x.t==='r'?'read ':x.t==='i'?'idle ':x.t==='b'?'break ':'gap ')+Math.round(x.s/60)+'m';")
    a(f, "return '<div title=""'+esc(tip)+'"" style=""flex:'+w.toFixed(3)+' 0 0;background:'+col+'""></div>';}).join('');")
    a(f, "return '<div class=""flow"">'+h+'</div>';}")
    a(f, "/* ---- day shape: when a day actually started and finished ----")
    a(f, "   Start is when the FIRST study opened (sign time minus its duration), not the")
    a(f, "   first sign - otherwise a long first read makes the day look like it began an")
    a(f, "   hour late. Finish is the last sign. */")
    a(f, "function hrOf(d){return d.getHours()+d.getMinutes()/60+d.getSeconds()/3600;}")
    a(f, "function hhmm(h){h=((h%24)+24)%24;var hh=Math.floor(h),mm=Math.round((h-hh)*60);")
    a(f, "if(mm===60){mm=0;hh=(hh+1)%24;}")
    a(f, "return (hh%12||12)+':'+String(mm).padStart(2,'0')+(hh<12?'a':'p');}")
    a(f, "function dayShape(dates){return dates.map(function(dt){")
    a(f, "var dd=V.filter(function(x){return x.date===dt;});")
    a(f, "if(dd.length<2)return null;                /* one study has no start-to-finish */")
    a(f, "var s=Infinity,e=-Infinity;")
    a(f, "dd.forEach(function(x){var t=new Date(x.ts).getTime();if(isNaN(t))return;")
    a(f, "var st=t-x.sec*1000;if(st<s)s=st;if(t>e)e=t;});")
    a(f, "if(!isFinite(s)||!isFinite(e))return null;")
    a(f, "var hs=hrOf(new Date(s)),he=hrOf(new Date(e));")
    a(f, "if(he<hs)he+=24;                           /* ran past midnight: unwrap the span */")
    a(f, "var fx=focusDay(dd),g=+(GOALMAP[dd[0].dRaw]||0);")
    a(f, "var ivu=sumIvu(dd);")
    a(f, "return{dt:dt,dy:(dd[0].day||''),st:hs,en:he,span:he-hs,n:dd.length,")
    a(f, "ivu:Math.round(ivu*100)/100,drift:fx.idle+(fx.inIdle||0),act:fx.active,")
    a(f, "goal:g,hit:g>0?(ivu>=g):null};}).filter(Boolean);}")
    a(f, "/* Least-squares fit of y on x, plus Pearson r. null when there is too little")
    a(f, "   spread in x to fit anything - a slope through three near-identical starts is")
    a(f, "   noise wearing a number. */")
    a(f, "function linfit(xs,ys){var n=xs.length,i;if(n<3)return null;")
    a(f, "var mx=0,my=0;for(i=0;i<n;i++){mx+=xs[i];my+=ys[i];}mx/=n;my/=n;")
    a(f, "var sxy=0,sxx=0,syy=0;")
    a(f, "for(i=0;i<n;i++){var dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy;}")
    a(f, "if(sxx<1e-6)return null;                          /* no spread in x to fit against */")
    a(f, "if(syy<1e-6)return{m:0,b:my,r:0,n:n,flat:true};   /* y never moves - a real finding, not a failure */")
    a(f, "var m=sxy/sxx;return{m:m,b:my-m*mx,r:sxy/Math.sqrt(sxx*syy),n:n};}")
    a(f, "function quant(arr,p){var s=arr.slice().sort(function(a,b){return a-b;});")
    a(f, "var i=(s.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);")
    a(f, "return s[lo]+(s[hi]-s[lo])*(i-lo);}")
    a(f, "function cdh(dd){if(!dd.length)return{a:0,o:0};")
    a(f, "var a=dd.reduce(function(s,d){return s+d.sec;},0);")
    a(f, "var st=dd.map(function(d){var e=new Date(d.ts);return{s:new Date(e-d.sec*1e3),e:e};}).sort(function(x,y){return x.s-y.s;});")
    a(f, "var G=18e5,o=0,ss=st[0].s,se=st[0].e;")
    a(f, "for(var i=1;i<st.length;i++){if(st[i].s-se>=G){o+=(se-ss)/1e3;ss=st[i].s;se=st[i].e;}else{if(st[i].e>se)se=st[i].e;}}")
    a(f, "o+=(se-ss)/1e3;return{a:a,o:Math.max(o,a)};}")
    a(f, "/* ---- chart plumbing ---- */")
    a(f, "Chart.defaults.color=MUT;Chart.defaults.borderColor=GRID;")
    a(f, "Chart.defaults.font.family=""system-ui,-apple-system,'Segoe UI',sans-serif"";Chart.defaults.font.size=11;")
    a(f, "Chart.defaults.maintainAspectRatio=false;")
    a(f, "Chart.defaults.plugins.tooltip.backgroundColor='#1c1c3a';Chart.defaults.plugins.tooltip.borderColor='#37376b';")
    a(f, "Chart.defaults.plugins.tooltip.borderWidth=1;Chart.defaults.plugins.tooltip.titleColor='#fff';")
    a(f, "Chart.defaults.plugins.tooltip.bodyColor='#d5d5e8';Chart.defaults.plugins.tooltip.padding=10;")
    a(f, "Chart.defaults.plugins.tooltip.cornerRadius=8;Chart.defaults.plugins.tooltip.displayColors=true;")
    a(f, "Chart.defaults.plugins.tooltip.boxWidth=10;Chart.defaults.plugins.tooltip.boxHeight=2;")
    a(f, "var LG={position:'bottom',labels:{padding:13,usePointStyle:true,pointStyle:'circle',boxWidth:7,font:{size:11}}};")
    a(f, "var REG={};")
    a(f, "function mk(id,cfg){var c=el(id);if(!c)return;if(REG[id])REG[id].destroy();")
    a(f, "cfg.options=cfg.options||{};cfg.options.responsive=true;cfg.options.maintainAspectRatio=false;")
    a(f, "if(!cfg.options.animation)cfg.options.animation={duration:520,easing:'easeOutQuart'};")
    a(f, "REG[id]=new Chart(c,cfg);}")
    a(f, "function ax(title){return{beginAtZero:true,grid:{color:GRID,drawTicks:false},border:{display:false},")
    a(f, "title:title?{display:true,text:title,color:MUT,font:{size:10}}:undefined};}")
    a(f, "function axX(){return{grid:{display:false},border:{display:false},ticks:{maxRotation:0,autoSkip:true}};}")
    a(f, "var BAR={borderRadius:4,borderSkipped:'bottom',maxBarThickness:24};")
    a(f, "var STACK={borderRadius:3,maxBarThickness:24,borderWidth:2,borderColor:SF};")
    a(f, "/* ---- animated numbers ---- */")
    a(f, "function countUp(node,to,dec,suffix){var from=0,t0=null,dur=650;")
    a(f, "if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){")
    a(f, "node.textContent=to.toFixed(dec)+(suffix||'');return;}")
    a(f, "function step(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-p,3);")
    a(f, "node.textContent=(from+(to-from)*e).toFixed(dec)+(suffix||'');if(p<1)requestAnimationFrame(step);}")
    a(f, "requestAnimationFrame(step);}")
    a(f, "/* ---- state ---- */")
    a(f, "var RANGE=0,V=D;")
    a(f, "function applyRange(){if(!RANGE){V=D;return;}")
    a(f, "var cut=ymd(new Date(Date.now()-RANGE*864e5));V=D.filter(function(d){return d.date>=cut;});")
    a(f, "if(!V.length)V=D.slice(-1);}")
    a(f, "/* =========================== RENDER =========================== */")
    a(f, "function render(){")
    a(f, "applyRange();")
    a(f, "var dates=[].concat(Array.from(new Set(V.map(function(d){return d.date;})))).sort();")
    a(f, "var DH={};dates.forEach(function(dt){var dd=V.filter(function(d){return d.date===dt;});var r=cdh(dd);")
    a(f, "var fx=focusDay(dd);DH[dt]={a:r.a,o:r.o,n:dd.length,dy:dd[0].day,idle:fx.idle,")
    a(f, "foc:fx.active>0?Math.round(fx.active/(fx.active+fx.idle)*100):100,")
    a(f, "ivu:sumIvu(dd)};});")
    a(f, "el('bDr').textContent=dates[0]+'  \u2192  '+dates[dates.length-1]+'  ('+dates.length+' days)';")
    a(f, "if(typeof TODAY_SHIFT!=='undefined'&&TODAY_SHIFT){el('bSh').style.display='';el('bShT').textContent=TODAY_SHIFT;}")
    a(f, "var mods=['CR','CT','MR','US','PET'].filter(function(m){return V.some(function(d){return d.mod===m;});});")
    a(f, "V.forEach(function(d){if(mods.indexOf(d.mod)<0&&d.mod)mods.push(d.mod);});")
    a(f, "/* ---------- shift aggregates ---------- */")
    a(f, "var BK={},SH={},shArr=[],modRows=[];")
    a(f, "var hasShift=V.some(function(d){return d.shift;});")
    a(f, "if(hasShift){")
    a(f, "V.forEach(function(d){if(!d.shift)return;var k=d.dRaw+'|'+d.shift;")
    a(f, "if(!BK[k]){var hrs=0,on=false;")
    a(f, "if(HASSH&&SHIFTS[d.dRaw])dayPlan(SHIFTS[d.dRaw])[0].forEach(function(p){if(p.name===d.shift){if(p.w)hrs=p.e-p.s;on=p.on;}});")
    a(f, "BK[k]={shift:d.shift,date:d.dRaw,ivu:0,n:0,sec:0,hrs:hrs,on:on,mods:new Set()};}")
    a(f, "BK[k].ivu+=d.ivu;BK[k].n++;BK[k].sec+=d.sec;")
    a(f, "if(d.extras)d.extras.split(' + ').forEach(function(m){BK[k].mods.add(m);});});")
    a(f, "Object.values(BK).forEach(function(b){var s=b.shift;")
    a(f, "if(!SH[s])SH[s]={blocks:0,n:0,ivu:0,sec:0,hrsSum:0,hrsCnt:0,on:b.on};")
    a(f, "SH[s].blocks++;SH[s].n+=b.n;SH[s].ivu+=b.ivu;SH[s].sec+=b.sec;")
    a(f, "if(b.hrs>0){SH[s].hrsSum+=b.hrs;SH[s].hrsCnt++;}if(b.on)SH[s].on=true;});")
    a(f, "shArr=Object.keys(SH).map(function(k){var s=SH[k],hrs=s.hrsCnt?s.hrsSum/s.hrsCnt:0,ipb=s.ivu/s.blocks;")
    a(f, "return{name:k,blocks:s.blocks,n:s.n,npb:Math.round(s.n/s.blocks*10)/10,ivu:Math.round(s.ivu*10)/10,")
    a(f, "ipb:Math.round(ipb*10)/10,iph:hrs>0?Math.round(ipb/hrs*10)/10:0,hrs:Math.round(hrs*10)/10,on:s.on};})")
    a(f, ".sort(function(a,b){return b.ipb-a.ipb;});")
    a(f, "var modAgg={};")
    a(f, "Object.values(BK).forEach(function(b){var bases=new Set(Array.from(b.mods).map(modBase));")
    a(f, "var all=new Set(Object.values(BK).filter(function(x){return x.shift===b.shift;})")
    a(f, ".flatMap(function(x){return Array.from(x.mods).map(modBase);}));")
    a(f, "all.forEach(function(m){if(!modAgg[m])modAgg[m]={};")
    a(f, "if(!modAgg[m][b.shift])modAgg[m][b.shift]={w:[0,0],o:[0,0]};")
    a(f, "var t=bases.has(m)?modAgg[m][b.shift].w:modAgg[m][b.shift].o;t[0]++;t[1]+=b.ivu;});});")
    a(f, "Object.keys(modAgg).forEach(function(m){var bw=0,iw=0,bo=0,io=0,wsum=0,dsum=0;")
    a(f, "Object.values(modAgg[m]).forEach(function(sh){if(sh.w[0]>=1&&sh.o[0]>=1){")
    a(f, "bw+=sh.w[0];iw+=sh.w[1];bo+=sh.o[0];io+=sh.o[1];")
    a(f, "var wgt=Math.min(sh.w[0],sh.o[0]);wsum+=wgt;dsum+=wgt*((sh.w[1]/sh.w[0])/(sh.o[1]/sh.o[0])-1);}});")
    a(f, "if(bw>=2&&bo>=2)modRows.push({m:m,bw:bw,iw:Math.round(iw/bw*10)/10,io:Math.round(io/bo*10)/10,d:Math.round(dsum/wsum*100)});});")
    a(f, "modRows.sort(function(a,b){return Math.abs(b.d)-Math.abs(a.d);});}")
    a(f, "renderToday(DH,shArr,BK,modRows);")
    a(f, "renderFocus(dates,DH);")
    a(f, "renderRhythm(dates);")
    a(f, "renderBank(dates,DH);")
    a(f, "renderShifts(dates,DH,hasShift,BK,SH,shArr,modRows,mods);")
    a(f, "renderExams(mods);")
    a(f, "renderLog(dates,DH,mods);}")
    a(f, "/* ---------------- TODAY ---------------- */")
    a(f, "function renderToday(DH,shArr,BK,modRows){")
    a(f, "var tr=V.filter(function(d){return d.date===TODAY;});")
    a(f, "var tN=tr.length,tSec=tr.reduce(function(a,d){return a+d.sec;},0),tAvg=tN?Math.round(tSec/tN):0;")
    a(f, "var tI=sumIvu(tr);")
    a(f, "var dh=DH[TODAY]||{a:0,o:0};var eff=dh.o>0?Math.round(dh.a/dh.o*100):0;")
    a(f, "var paceH=dh.a>0?Math.round(tI/(dh.a/3600)*10)/10:0;")
    a(f, "var fx=focusDay(tr),idleM=Math.round(fx.idle/60);")
    a(f, "var foc=fx.active>0?Math.round(fx.active/(fx.active+fx.idle)*100):100;")
    a(f, "var reclaim=fx.active>0?Math.round(fx.idle/fx.active*tI*10)/10:0;")
    a(f, "var extraN=tAvg>0?Math.round(fx.idle/tAvg):0;")
    a(f, "var typMap={};shArr.forEach(function(s){typMap[s.name]={ipb:s.ipb,d:s.blocks};});")
    a(f, "var modD={};modRows.forEach(function(r){modD[r.m]=r.d/100;});")
    a(f, "var proj=0,haveProj=false,blocks=[];")
    a(f, "if(HASSH&&HASCLS&&SHIFTS[TRAW]){var pm=dayPlan(SHIFTS[TRAW]),P=pm[0],M=pm[1];")
    a(f, "P.forEach(function(p){var st=typMap[p.name],eI=(st&&st.d>=2)?st.ipb:0;if(st&&st.d>=2)haveProj=true;")
    a(f, "M.forEach(function(m){var mb=modBase(m.name),ov=!m.w||!p.w||(m.s<p.e&&p.s<m.e);")
    a(f, "if(ov&&modD[mb]!==undefined)eI*=(1+modD[mb]);});")
    a(f, "proj+=eI;blocks.push((p.on?'\u2605 ':'')+p.name);});}")
    a(f, "proj=Math.round(proj*10)/10;")
    a(f, "var target=GOAL>0?GOAL:(haveProj?proj:0);")
    a(f, "var pct=target>0?Math.round(tI/target*100):0;")
    a(f, "var curName=(typeof TODAY_SHIFT!=='undefined')?TODAY_SHIFT:'';")
    a(f, "/* hero */")
    a(f, "var R=52,C=2*Math.PI*R,off=C*(1-Math.min(1,target>0?tI/target:0));")
    a(f, "var ringCol=pct>=100?GOODC:pct>=60?'#3987e5':WARNC;")
    a(f, "var h='<div class=""hero""><div class=""heroTop""><span class=""t"">Today</span><span class=""s"">'+esc(TODAY)+")
    a(f, "(curName?' \u00B7 '+esc(curName):'')+'</span></div><div class=""heroMain"">';")
    a(f, "if(target>0){h+='<svg class=""ring"" width=""124"" height=""124"" viewBox=""0 0 124 124"" aria-hidden=""true"">'+")
    a(f, "'<circle cx=""62"" cy=""62"" r=""52"" fill=""none"" stroke=""#0c0c1e"" stroke-width=""10""/>'+")
    a(f, "'<circle cx=""62"" cy=""62"" r=""52"" fill=""none"" stroke=""'+ringCol+'"" stroke-width=""10"" stroke-linecap=""round"" '+")
    a(f, "'stroke-dasharray=""'+C.toFixed(1)+'"" stroke-dashoffset=""'+off.toFixed(1)+'"" transform=""rotate(-90 62 62)"" '+")
    a(f, "'style=""transition:stroke-dashoffset .9s cubic-bezier(.22,1,.36,1)""/></svg>';}")
    a(f, "h+='<div><div class=""heroNum"" id=""heroN"">0</div><div class=""heroUnit"">IVU today</div></div>';")
    a(f, "if(target>0){h+='<div class=""heroSide""><div class=""meter""><i style=""width:'+Math.min(100,pct)+'%;background:'+ringCol+'""></i></div>'+")
    a(f, "'<div class=""mrow""><span>'+pct+'% of '+(GOAL>0?'goal':'projected')+'</span><span>'+")
    a(f, "Math.max(0,Math.round((target-tI)*10)/10)+' to go</span></div></div>';}")
    a(f, "h+='</div></div>';")
    a(f, "var hw=el('heroWrap');")
    a(f, "/* machine-readable hooks so the headless harness can assert the focus math */")
    a(f, "hw.setAttribute('data-idle',Math.round(fx.idle));")
    a(f, "hw.setAttribute('data-gaps',fx.gc);")
    a(f, "hw.setAttribute('data-reclaim',reclaim);")
    a(f, "hw.setAttribute('data-inidle',Math.round(fx.inIdle||0));")
    a(f, "hw.setAttribute('data-inmeas',Math.round(fx.inMeas||0));")
    a(f, "hw.innerHTML=h;")
    a(f, "if(el('heroN'))countUp(el('heroN'),Math.round(tI*10)/10,1,'');")
    a(f, "/* tiles */")
    a(f, "var idleCol=fx.idle>=600?CRITC:fx.idle>=180?WARNC:GOODC;")
    a(f, "var g='';")
    a(f, "function tile(lb,val,col,sub){return '<div class=""cd""><div class=""lb"">'+esc(lb)+'</div><div class=""vl"" style=""color:'+col+")
    a(f, "'"">'+esc(val)+'</div><div class=""sb"">'+(sub||'')+'</div></div>';}")
    a(f, "g+=tile('Studies',tN,'#fff',tN?('avg <b>'+ft(tAvg)+'</b> each'):'none yet');")
    a(f, "g+=tile('Active time',fh(dh.a),'#c98500',eff?('eff <b>'+eff+'%</b> \u00B7 clock '+fh(dh.o)):'');")
    a(f, "g+=tile('Pace',(paceH||'--'),'#3987e5','IVU per active hour');")
    a(f, "/* Credits, not raw IVU: credit accrues in whole rungs, so this is the number")
    a(f, "   the day actually pays out on. */")
    a(f, "if(LAD){var cNow=credits(tI),cNxt=nextRung(tI);")
    a(f, "g+=tile('Credits',cNow,cNow>0?GOODC:MUT,r1(LAD.s)+' IVU = 1 credit = 1h'+")
    a(f, "(cNxt>tI?' &middot; <b>'+r1(cNxt-tI)+'</b> to next':''));}")
    a(f, "g+=tile('Idle time',idleM+'m',idleCol,fx.gc?('<b>'+fx.gc+'</b> gap'+(fx.gc==1?'':'s')+' \u00B7 focus <b>'+foc+'%</b>'):'no gaps');")
    a(f, "/* Where today's IVU came from. A number matched out of the report's prose is")
    a(f, "   a guess; PowerScribe's own figure for the procedure code is not. The two")
    a(f, "   used to be indistinguishable once written to the log, which is how the")
    a(f, "   totals drifted from PowerScribe's without anyone being able to say where.")
    a(f, "   Shown only once rows actually carry a source - it is silent on old data")
    a(f, "   rather than reporting 0% and implying something is wrong. */")
    a(f, "var srcKnown=tr.filter(function(d){return d.src;}).length;")
    a(f, "if(srcKnown>0){var firmN=tr.filter(function(d){return d.firm;}).length,")
    a(f, "firmPct=Math.round(firmN/srcKnown*100);")
    a(f, "g+=tile('IVU from source',firmN+' of '+srcKnown,")
    a(f, "firmPct>=80?GOODC:firmPct>=40?WARNC:CRITC,")
    a(f, "'PowerScribe or an exact code \u00B7 rest matched on text');}")
    a(f, "/* Measured in-study inactivity - only shown once rows carry ActiveSec */")
    a(f, "if(fx.inMeas>0){var im=Math.round(fx.inIdle/60);")
    a(f, "var trueFoc=Math.round((fx.inMeas-fx.inIdle)/fx.inMeas*100);")
    a(f, "g+=tile('Drifted off',im+'m',fx.inIdle>=600?CRITC:fx.inIdle>=180?WARNC:GOODC,")
    a(f, "'inside studies \u00B7 hands-on <b>'+trueFoc+'%</b>');}")
    a(f, "/* Cost covers BOTH kinds of drift: gaps BETWEEN studies and dead time INSIDE")
    a(f, "   them. Pricing only the between-study gaps hid the cost entirely on days")
    a(f, "   where the drifting happened mid-study. */")
    a(f, "var driftSec=fx.idle+(fx.inIdle||0);")
    a(f, "if(RATE>0&&driftSec>0)")
    a(f, "g+=tile('Cost of drifting',moneyFor(driftSec),CRITC,")
    a(f, "Math.round(driftSec/60)+'m lost today, at your rate');")
    a(f, "el('tGrid').innerHTML=g;")
    a(f, "/* flow + alert */")
    a(f, "if(fx.segs.length){el('bxTFlow').style.display='';el('tFlow').innerHTML=flowStrip(fx.segs);")
    a(f, "el('tAlert').innerHTML=fx.idle>=180")
    a(f, "?'<div class=""alert"">\u26A1 <b>'+idleM+'m</b> lost to '+fx.gc+' idle gap'+(fx.gc==1?'':'s')+' \u2014 about <b>'+")
    a(f, "reclaim+' IVU</b>'+(extraN>0?' (\u2248'+extraN+' more '+(extraN==1?'study':'studies')+')':'')+")
    a(f, "' left on the table'+(RATE>0?', <b>'+moneyFor(fx.idle)+'</b> of your time':'')+")
    a(f, "'. Batch your reads to claw it back.</div>'")
    a(f, ":(tN>=3?'<div class=""good"">\u2713 Tight focus \u2014 only '+idleM+'m idle today. Keep stacking reads back to back.</div>':'');}")
    a(f, "else{el('bxTFlow').style.display='none';}")
    a(f, "renderFiller(driftSec,tI);")
    a(f, "/* notes */")
    a(f, "var others=Object.keys(DH).filter(function(x){return x!==TODAY;}).map(function(x){return DH[x].ivu;}).filter(function(v){return v>0;});")
    a(f, "var avgDay=others.length?others.reduce(function(a,b){return a+b;},0)/others.length:0;")
    a(f, "var vsAvg=avgDay>0?Math.round((tI/avgDay-1)*100):0;")
    a(f, "var notes=[];")
    a(f, "if(curName){var bk=Object.values(BK).find(function(b){return b.date===TRAW&&b.shift===curName;});")
    a(f, "var soFar=bk?Math.round(bk.ivu*10)/10:0,st=typMap[curName];")
    a(f, "notes.push(st&&st.d>=2")
    a(f, "?'<b>'+esc(curName)+'</b>: '+soFar+' IVU so far vs '+st.ipb+' typical ('+(st.ipb>0?Math.round(soFar/st.ipb*100):0)+'%)'")
    a(f, ":'<b>'+esc(curName)+'</b>'+(soFar>0?': '+soFar+' IVU so far':''));}")
    a(f, "if(avgDay>0&&tN)notes.push('Today\u2019s '+Math.round(tI*10)/10+' IVU is <span class=""'+(vsAvg>=0?'hi':'lo')+'"">'+")
    a(f, "(vsAvg>0?'+':'')+vsAvg+'%</span> vs your '+Math.round(avgDay*10)/10+' average day.');")
    a(f, "if(blocks.length)notes.push('Scheduled: '+esc(blocks.join('  +  '))+(haveProj?(' \u00B7 projected ~'+proj+' IVU'):''));")
    a(f, "var mm={};tr.forEach(function(d){mm[d.mod]=(mm[d.mod]||0)+1;});")
    a(f, "var chips=Object.keys(mm).map(function(m){return '<span class=""mb '+esc(m)+'"">'+esc(m)+' '+mm[m]+'</span>';}).join('');")
    a(f, "el('tNotes').innerHTML=(notes.length||chips)")
    a(f, "?'<div class=""bx"">'+(notes.length?'<ul class=""ins"">'+notes.map(function(n){return '<li>'+n+'</li>';}).join('')+'</ul>':'')+")
    a(f, "(chips?'<div class=""chips"">'+chips+'</div>':'')+'</div>'")
    a(f, ":(tN?'':'<div class=""bx""><div class=""empty"">No studies signed yet today.</div></div>');}")
    a(f, "/* ---- filler math ----")
    a(f, "   Two questions, both answered in whole studies rather than in IVU:")
    a(f, "     1. how many did the drifting cost me")
    a(f, "     2. how many more to land on my number")
    a(f, "   Deliberately counts studies and not minutes: the point is never to read a")
    a(f, "   study faster, it is to not lose the hour between studies. */")
    a(f, "function fq(cls,n,txt,sub){return '<div class=""fq '+cls+'""><div class=""qn"">'+n+'</div><div><div class=""qt"">'+txt+")
    a(f, "'</div><div class=""qs"">'+sub+'</div></div></div>';}")
    a(f, "/* What landing on ``target`` is worth over where you stand now. A credit IS an")
    a(f, "   hour, so pricing it keeps to the same rule as the rest of the app: dollars")
    a(f, "   attach to time, never to a study. */")
    a(f, "function credTail(target,now){")
    a(f, "if(!LAD)return '';")
    a(f, "var gain=credits(target)-credits(now);")
    a(f, "if(gain<=0)return '';")
    a(f, "return ' <span class=""cred"">+'+nCred(gain)+(RATE>0?', '+usd(gain*RATE):'')+'</span>';}")
    a(f, "function renderFiller(driftSec,tI){")
    a(f, "var box=el('bxFill');if(!box)return;")
    a(f, "if(!FSTAT){box.style.display='none';return;}")
    a(f, "box.style.display='';")
    a(f, "var one=esc(FSTAT.name),many=one+'s';")
    a(f, "el('fillH').textContent=FSTAT.name.charAt(0).toUpperCase()+FSTAT.name.slice(1)+'s, as a unit';")
    a(f, "el('fillD').innerHTML=FSTAT.n>0")
    a(f, "?'Calibrated from the <b>'+FSTAT.n+'</b> in your log: <b>'+FSTAT.ivu+' IVU</b> each'+")
    a(f, "(FSTAT.sec>0?', <b>'+ft(Math.round(FSTAT.sec))+'</b> of engaged time each':'')+'.'")
    a(f, ":'None in your log yet, so this uses the IVU table value of <b>'+FSTAT.ivu+'</b> each.';")
    a(f, "var g='',lostN=0,need=0;")
    a(f, "/* 1. what the drifting cost, in whole studies */")
    a(f, "if(FSTAT.sec>0&&driftSec>0){")
    a(f, "var lost=driftSec/FSTAT.sec;lostN=Math.floor(lost);")
    a(f, "g+=fq(lostN>=1?'dn':'nu',lost>=10?Math.round(lost):(lost>=1?lostN:r1(lost)),")
    a(f, "'<b>'+(lostN===1?one:many)+'</b> went into drifting instead',")
    a(f, "Math.round(driftSec/60)+'m adrift today &divide; '+ft(Math.round(FSTAT.sec))+' each'+")
    a(f, "(RATE>0?' &middot; '+moneyFor(driftSec):''));}")
    a(f, "/* 2. what is left between here and the number still in play */")
    a(f, "var short=GOAL>0?GOAL-tI:0,aim='',aimAt=0;")
    a(f, "if(GOAL>0&&short>0){aim='your goal';aimAt=GOAL;need=Math.ceil(short/FSTAT.ivu);")
    a(f, "g+=fq('nu',need,'more to hit <b>'+r1(GOAL)+'</b>'+credTail(GOAL,tI),")
    a(f, "r1(short)+' IVU short &middot; '+FSTAT.ivu+' IVU each');}")
    a(f, "else{")
    a(f, "/* Past the goal (or never set one). The next rung is the whole answer to")
    a(f, "   ""I hit my number, why keep going"" - without it the goal is just a ceiling. */")
    a(f, "var rung=nextRung(GOAL>0?Math.max(GOAL,tI):tI);")
    a(f, "if(GOAL>0)g+=fq('up','&#10003;','<b>'+r1(GOAL)+'</b> is done, '+r1(tI-GOAL)+' IVU past it',")
    a(f, "'goal cleared'+(credits(tI)>0?' &middot; '+nCred(credits(tI))+' banked':''));")
    a(f, "if(rung>tI){aim='the next rung';aimAt=rung;need=Math.ceil((rung-tI)/FSTAT.ivu);")
    a(f, "g+=fq('nu',need,'more to reach <b>'+r1(rung)+'</b>'+credTail(rung,tI),")
    a(f, "r1(rung-tI)+' IVU to go'+(GOAL>0?'':' &middot; no goal set today'));}}")
    a(f, "el('fillGrid').innerHTML=g;")
    a(f, "/* The sentence that ties the two together - drifting stops being abstract once")
    a(f, "   it is measured against the gap you still have to close. */")
    a(f, "var note='';")
    a(f, "if(lostN>0&&need>0)note=lostN>=need")
    a(f, "?'The drifting alone was worth more than the whole gap to '+aim+': <b>'+need+'</b> to go, '+")
    a(f, "'and <b class=""lo"">'+lostN+'</b> already let go.'")
    a(f, ":'You are <b>'+need+'</b> off '+aim+' at <b>'+r1(aimAt)+'</b>, and <b class=""lo"">'+lostN+")
    a(f, "'</b> of that went to drifting.'+(lostN*3>=need?' Close the gaps and you are most of the way there.':'');")
    a(f, "else if(lostN>0)note='Nothing left to chase today &mdash; but that is still <b class=""lo"">'+lostN+'</b> '+")
    a(f, "(lostN===1?one:many)+' of reading that went nowhere.';")
    a(f, "el('fillNote').innerHTML=note;}")
    a(f, "/* ---------------- FOCUS ---------------- */")
    a(f, "function renderFocus(dates,DH){")
    a(f, "var wd=dates.filter(function(dt){return DH[dt].n>0;});")
    a(f, "if(!wd.length)return;")
    a(f, "var per=wd.map(function(dt){return{dt:dt,idle:DH[dt].idle,foc:DH[dt].foc,ivu:DH[dt].ivu,")
    a(f, "fx:focusDay(V.filter(function(x){return x.date===dt;}))};});")
    a(f, "var tIdle=per.reduce(function(a,d){return a+d.idle;},0);")
    a(f, "var tAct=per.reduce(function(a,d){return a+d.fx.active;},0);")
    a(f, "var tIvu=per.reduce(function(a,d){return a+d.ivu;},0);")
    a(f, "var reclaimAll=tAct>0?tIdle/tAct*tIvu:0;")
    a(f, "var weeks=Math.max(1,wd.length/5),wkReclaim=reclaimAll/weeks;")
    a(f, "var avgFoc=Math.round(per.reduce(function(a,d){return a+d.foc;},0)/per.length);")
    a(f, "/* streaks */")
    a(f, "var best=per.filter(function(d){return d.fx.active>=1800;}).sort(function(a,b){return b.foc-a.foc;})[0];")
    a(f, "var clean=per.filter(function(d){return d.idle<300;}).length;")
    a(f, "var run=0,bestRun=0;per.forEach(function(d){if(d.foc>=avgFoc){run++;if(run>bestRun)bestRun=run;}else run=0;});")
    a(f, "var s='';")
    a(f, "function stk(e,n,l){return '<div class=""stk""><div class=""e"">'+e+'</div><div class=""n"">'+esc(n)+'</div><div class=""l"">'+esc(l)+'</div></div>';}")
    a(f, "s+=stk('\uD83C\uDFAF',avgFoc+'%','avg focus');")
    a(f, "s+=stk('\u2728',clean,'clean days');")
    a(f, "s+=stk('\uD83D\uDD25',bestRun,'best streak');")
    a(f, "if(best)s+=stk('\uD83C\uDFC6',best.foc+'%','best day '+best.dt.slice(5));")
    a(f, "el('fStreaks').innerHTML=s;")
    a(f, "/* ---- Par: only counts studies that actually carried a bet ---- */")
    a(f, "var bets=V.filter(function(d){return d.par>0&&d.act>=0;});")
    a(f, "if(bets.length){")
    a(f, "el('bxPar').style.display='';")
    a(f, "var wins=bets.filter(function(d){return d.act<=d.par;}).length;")
    a(f, "var wr=Math.round(wins/bets.length*100);")
    a(f, "var cur=0,bestRun=0;")
    a(f, "bets.forEach(function(d){if(d.act<=d.par){cur++;if(cur>bestRun)bestRun=cur;}else cur=0;});")
    a(f, "el('parSum').innerHTML='<b>'+wins+'</b> of <b>'+bets.length+'</b> studies came in under par '+")
    a(f, "'(<span class=""'+(wr>=50?'hi':'lo')+'"">'+wr+'%</span>). Best run: <b class=""hi"">'+bestRun+")
    a(f, "'</b> in a row &middot; current run: <b>'+cur+'</b>.';")
    a(f, "var pm={};")
    a(f, "bets.forEach(function(d){var k=d.exam||'(unknown)';")
    a(f, "if(!pm[k])pm[k]={n:0,w:0,d:[]};")
    a(f, "pm[k].n++;if(d.act<=d.par)pm[k].w++;pm[k].d.push(d.act-d.par);});")
    a(f, "var prow=Object.keys(pm).map(function(k){var m=pm[k];")
    a(f, "var sorted=m.d.slice().sort(function(a,b){return a-b;});")
    a(f, "var mid=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;")
    a(f, "return{name:k,n:m.n,w:m.w,wr:Math.round(m.w/m.n*100),med:Math.round(mid)};})")
    a(f, ".filter(function(r){return r.n>=3;}).sort(function(a,b){return b.n-a.n;});")
    a(f, "var pb='';")
    a(f, "prow.forEach(function(r){")
    a(f, "var cls=r.wr>=50?'up':'dn';")
    a(f, "var sign=r.med<=0?'-':'+';")
    a(f, "pb+='<tr><td>'+esc(r.name)+'</td><td>'+r.n+'</td><td>'+r.w+'</td><td class=""'+cls+")
    a(f, "'"" style=""font-weight:650"">'+r.wr+'%</td><td class=""'+(r.med<=0?'up':'dn')+'"">'+sign+ft(Math.abs(r.med))+'</td></tr>';});")
    a(f, "document.querySelector('#tPar tbody').innerHTML=pb||")
    a(f, "'<tr><td colspan=""5"" class=""nt"" style=""text-align:center;padding:18px"">Need 3+ bets on an exam type</td></tr>';")
    a(f, "}else{el('bxPar').style.display='none';}")
    a(f, "var tInIdle=per.reduce(function(a,d){return a+(d.fx.inIdle||0);},0);")
    a(f, "var tInMeas=per.reduce(function(a,d){return a+(d.fx.inMeas||0);},0);")
    a(f, "var halfHrsWk=(tIdle/2)/Math.max(1,wd.length/5)/3600;")
    a(f, "var head='Across <b>'+wd.length+'</b> worked days you lost <b class=""lo"">'+(Math.round(tIdle/360)/10)+")
    a(f, "'h</b> to idle gaps \u2014 roughly <b class=""tot"">'+Math.round(reclaimAll)+' IVU</b> of reading at your own pace'+")
    a(f, "(RATE>0?', or <b class=""tot"">'+moneyFor(tIdle)+'</b> of your time':'')+'.<br>'+")
    a(f, "'Halving those gaps is about <b class=""hi"">+'+(Math.round(wkReclaim/2*10)/10)+' IVU per week</b>'+")
    a(f, "(RATE>0?' \u2014 <b class=""hi"">'+(Math.round(halfHrsWk*10)/10)+'h</b> back, worth <b class=""hi"">'+usd(halfHrsWk*RATE)+'</b> a week':'')+'.';")
    a(f, "if(tInMeas>0){var hands=Math.round((tInMeas-tInIdle)/tInMeas*100);")
    a(f, "head+='<br><br>On top of that, <b class=""lo"">'+(Math.round(tInIdle/360)/10)+'h</b> passed <i>inside</i> studies with '+")
    a(f, "'no keyboard or mouse at all \u2014 the clock was running but you weren\u2019t'+")
    a(f, "(RATE>0?' ('+moneyFor(tInIdle)+')':'')+'. Hands-on for <b>'+hands+'%</b> of measured study time.';}")
    a(f, "if(FSTAT&&FSTAT.sec>0){var wkN=Math.round((tIdle+tInIdle)/Math.max(1,wd.length/5)/FSTAT.sec);")
    a(f, "if(wkN>0)head+='<br><br>In your own currency, that is about <b class=""lo"">'+wkN+'</b> '+")
    a(f, "esc(FSTAT.name)+(wkN===1?'':'s')+' a week you never got to read.';}")
    a(f, "/* ---- Daily goal consistency ----")
    a(f, "   Measures three things, because any two of them can lie on their own:")
    a(f, "     1. did you clear the line")
    a(f, "     2. how far past it did you go   (a goal quietly becomes a ceiling)")
    a(f, "     3. HOW BIG WAS THE LINE")
    a(f, "   A percentage with no magnitude behind it inverts the ranking: 90% of a 25")
    a(f, "   IVU goal is 22.5 IVU, while 60% of a 100 IVU goal is 60. The first looks")
    a(f, "   better and is less than half the work. So the chart plots absolute IVU")
    a(f, "   against the goal marker on ONE axis, and the headline number is the")
    a(f, "   volume-weighted aggregate, not the mean of the percentages. ---- */")
    a(f, "(function(){")
    a(f, "var gd=[];")
    a(f, "Object.keys(GOALMAP).forEach(function(k){")
    a(f, "var g=+GOALMAP[k];if(!(g>0))return;")
    a(f, "var p=k.split('/');if(p.length<3)return;")
    a(f, "var iso=p[2]+'-'+String(p[0]).padStart(2,'0')+'-'+String(p[1]).padStart(2,'0');")
    a(f, "if(!DH[iso])return;                       /* no studies logged that day */")
    a(f, "gd.push({iso:iso,goal:g,got:DH[iso].ivu,pct:Math.round(DH[iso].ivu/g*100)});});")
    a(f, "gd.sort(function(a,b){return a.iso<b.iso?-1:1;});")
    a(f, "if(!gd.length){el('bxGoal').style.display='none';return;}")
    a(f, "el('bxGoal').style.display='';")
    a(f, "var hit=gd.filter(function(d){return d.got>=d.goal;}).length;")
    a(f, "var rate=Math.round(hit/gd.length*100);")
    a(f, "var cur=0,best=0;")
    a(f, "gd.forEach(function(d){if(d.got>=d.goal){cur++;if(cur>best)best=cur;}else cur=0;});")
    a(f, "var avgPct=Math.round(gd.reduce(function(a,d){return a+d.pct;},0)/gd.length);")
    a(f, "var coast=gd.filter(function(d){return d.pct>=100&&d.pct<=105;}).length;")
    a(f, "/* Volume-weighted: total delivered over total committed. Immune to a small")
    a(f, "   goal inflating the average, which the mean of percentages is not. */")
    a(f, "var sumGot=gd.reduce(function(a,d){return a+d.got;},0);")
    a(f, "var sumGoal=gd.reduce(function(a,d){return a+d.goal;},0);")
    a(f, "var aggPct=sumGoal>0?Math.round(sumGot/sumGoal*100):0;")
    a(f, "/* How ambitious the line itself is, against a normal worked day. A goal that")
    a(f, "   sits below your median day is a soft goal however often you clear it. */")
    a(f, "var allDay=Object.keys(DH).map(function(k){return DH[k].ivu;}).filter(function(v){return v>0;});")
    a(f, "/* Needs a few days to mean anything - with two, ""typical"" is drawn from the")
    a(f, "   same days being judged and the comparison is circular. */")
    a(f, "var typDay=allDay.length>=5?med(allDay):0;")
    a(f, "var medGoal=med(gd.map(function(d){return d.goal;}));")
    a(f, "var amb=typDay>0?Math.round(medGoal/typDay*100):0;")
    a(f, "var gs='';")
    a(f, "gs+=stk('\uD83C\uDFAF',rate+'%','goals hit');")
    a(f, "gs+=stk('\u2696',aggPct+'%','delivered vs committed');")
    a(f, "gs+=stk('\uD83D\uDCC8',avgPct+'%','average finish');")
    a(f, "gs+=stk('\uD83D\uDCCF',(amb||'--')+'%','goal vs typical day');")
    a(f, "gs+=stk('\uD83C\uDFC5',best,'best streak');")
    a(f, "el('goalStk').innerHTML=gs;")
    a(f, "/* The note has to be able to say ""you cleared it often and it did not amount")
    a(f, "   to much"", which is exactly what a hit rate alone cannot say. */")
    a(f, "var note='You set a goal on <b>'+gd.length+'</b> day'+(gd.length==1?'':'s')+', cleared it on <b class=""hi"">'+")
    a(f, "hit+'</b>, and delivered <b>'+r1(sumGot)+'</b> IVU against <b>'+r1(sumGoal)+'</b> committed '+")
    a(f, "'(<b'+(aggPct>=100?' class=""hi""':'')+'>'+aggPct+'%</b>).';")
    a(f, "if(aggPct>avgPct+5)note+=' Your big-goal days are carrying the weight: the volume-weighted number beats '+")
    a(f, "'the plain average of <b>'+avgPct+'%</b>, which means you deliver more when the line is set higher.';")
    a(f, "else if(avgPct>aggPct+5)note+=' Careful &mdash; the plain average (<b>'+avgPct+'%</b>) flatters you against '+")
    a(f, "'the volume-weighted <b>'+aggPct+'%</b>: the small-goal days pull the percentage up while the big '+")
    a(f, "'ones fall short. The bigger day is more work even when it scores worse.';")
    a(f, "if(amb>0&&amb<95)note+=' Your median goal is <b class=""lo"">'+medGoal+'</b> IVU against a typical day of <b>'+")
    a(f, "r1(typDay)+'</b> &mdash; the bar is set below a normal day, so clearing it is not the same as a good day.';")
    a(f, "else if(amb>=110)note+=' Your median goal of <b class=""hi"">'+medGoal+'</b> IVU sits well above a typical '+")
    a(f, "r1(typDay)+' day. These are real commitments.';")
    a(f, "if(coast>0)note+=' On <b class=""lo"">'+coast+'</b> day'+(coast==1?'':'s')+' you stopped within 5% of the line '+")
    a(f, "'&mdash; the goal became the ceiling.';")
    a(f, "el('goalNote').innerHTML=note;")
    a(f, "/* Bars are what you actually delivered, in IVU. The dash is that day's goal.")
    a(f, "   One axis, both facts, and the percentage is readable as the gap between")
    a(f, "   them - a tall bar that misses is visibly more work than a short one that")
    a(f, "   clears. Outcome rides on the tick label, never the bar fill: green vs red")
    a(f, "   is 4.1 deltaE apart under deuteranopia. */")
    a(f, "mk('chGoal',{type:'bar',data:{")
    a(f, "labels:gd.map(function(d){return (d.got>=d.goal?'\u2713 ':'\u2717 ')+d.iso.slice(5);}),")
    a(f, "datasets:[")
    a(f, "{label:'IVU finished',data:gd.map(function(d){return r1(d.got);}),")
    a(f, "backgroundColor:SPAL[0],...BAR,order:2},")
    a(f, "{label:'Goal',type:'line',data:gd.map(function(d){return r1(d.goal);}),")
    a(f, "showLine:false,pointStyle:'line',pointRadius:12,pointHoverRadius:14,")
    a(f, "pointBorderColor:MUT,pointBorderWidth:2,order:1}]},")
    a(f, "options:{plugins:{legend:{position:'bottom',")
    a(f, "labels:{padding:13,usePointStyle:true,boxWidth:14,font:{size:11}}},")
    a(f, "tooltip:{callbacks:{label:function(c){")
    a(f, "var d=gd[c.dataIndex];")
    a(f, "return c.datasetIndex===0")
    a(f, "?('finished '+r1(d.got)+' IVU  ('+d.pct+'% of goal)')")
    a(f, ":('goal '+r1(d.goal)+' IVU');}}}},")
    a(f, "scales:{y:ax('IVU'),")
    a(f, "x:{grid:{display:false},border:{display:false},")
    a(f, "ticks:{maxRotation:0,autoSkip:true,color:function(c){var d=gd[c.index];")
    a(f, "return !d?MUT:(d.got>=d.goal?GOODC:CRITC);}}}}}});")
    a(f, "el('tvGoal').innerHTML=tbl(['Date','Goal','Finished','% of goal','vs typical day'],")
    a(f, "gd.map(function(d){return[d.iso,r1(d.goal),r1(d.got),d.pct+'%',")
    a(f, "typDay>0?(Math.round(d.got/typDay*100)+'%'):'--'];}));")
    a(f, "})();")
    a(f, "el('fHead').innerHTML=head;")
    a(f, "/* Lead the tab with the number, not a sentence containing the number. */")
    a(f, "if(RATE>0&&tIdle>0){")
    a(f, "var wkCost=(tIdle/Math.max(1,wd.length/5))/3600*RATE;")
    a(f, "el('costBanner').style.display='';")
    a(f, "el('costBanner').innerHTML=")
    a(f, "'<div><div class=""big"">'+moneyFor(tIdle+tInIdle)+'</div><div class=""cap"">cost of drifting</div></div>'+")
    a(f, "'<div class=""side"">Across <b>'+wd.length+'</b> worked days: <b>'+(Math.round(tIdle/360)/10)+'h</b> in gaps between studies'+")
    a(f, "(tInMeas>0?' and <b>'+(Math.round(tInIdle/360)/10)+'h</b> parked inside them':'')+'.<br>'+")
    a(f, "'That is <b>'+usd(wkCost)+'</b> a week &mdash; halve it and you keep <span class=""win"">'+usd(wkCost/2)+' a week</span>.</div>';")
    a(f, "}else{el('costBanner').style.display='none';}")
    a(f, "/* strips */")
    a(f, "var recent=per.slice(-14),sh='';")
    a(f, "recent.forEach(function(d){var im=Math.round(d.idle/60);")
    a(f, "var col=d.idle>=1200?CRITC:d.idle>=300?WARNC:GOODC;")
    a(f, "sh+='<div class=""fRow""><div class=""fDt"">'+esc(d.dt.slice(5))+'</div><div class=""fId"" style=""color:'+col+'"">'+im+'m</div>'+")
    a(f, "flowStrip(d.fx.segs)+'</div>';});")
    a(f, "el('fStrips').innerHTML=sh;")
    a(f, "var L=per.map(function(d){return d.dt.slice(5);});")
    a(f, "mk('chIdle',{type:'bar',data:{labels:L,datasets:[{label:'Idle min',data:per.map(function(d){return Math.round(d.idle/60);}),")
    a(f, "backgroundColor:CRITC,...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('minutes'),x:axX()}}});")
    a(f, "el('tvIdle').innerHTML=tbl(['Date','Idle min','Gaps'],per.map(function(d){return[d.dt,Math.round(d.idle/60),d.fx.gc];}));")
    a(f, "mk('chFoc',{type:'line',data:{labels:L,datasets:[{label:'Focus %',data:per.map(function(d){return d.foc;}),")
    a(f, "borderColor:GOODC,backgroundColor:'rgba(12,163,12,.10)',fill:true,tension:.3,borderWidth:2,")
    a(f, "pointRadius:0,pointHoverRadius:5,pointHitRadius:24}]},")
    a(f, "options:{plugins:{legend:{display:false}},scales:{y:Object.assign(ax('%'),{max:100}),x:axX()},")
    a(f, "interaction:{mode:'index',intersect:false}}});")
    a(f, "el('tvFoc').innerHTML=tbl(['Date','Focus %'],per.map(function(d){return[d.dt,d.foc+'%'];}));")
    a(f, "/* tax */")
    a(f, "var flowS=[],gapS=[];")
    a(f, "wd.forEach(function(dt){var r=V.filter(function(x){return x.date===dt;}).map(function(d){var e=new Date(d.ts).getTime();")
    a(f, "return{st:e-d.sec*1000,en:e,sec:d.sec};}).filter(function(x){return x.en>0;}).sort(function(a,b){return a.st-b.st;});")
    a(f, "for(var i=1;i<r.length;i++){var gap=(r[i].st-r[i-1].en)/1000;if(gap<0)gap=0;")
    a(f, "if(gap<=FMICRO)flowS.push(r[i].sec);else if(gap>300&&gap<FBREAK)gapS.push(r[i].sec);}});")
    a(f, "var fAvg=flowS.length?flowS.reduce(function(a,b){return a+b;},0)/flowS.length:0;")
    a(f, "var gAvg=gapS.length?gapS.reduce(function(a,b){return a+b;},0)/gapS.length:0;")
    a(f, "var tx='';")
    a(f, "if(flowS.length>=10&&gapS.length>=10){var tp=Math.round((gAvg/fAvg-1)*100);")
    a(f, "tx+=tp>=5?'<div>Studies picked up <b>right after a break</b> take <b class=""lo"">'+tp+'% longer</b> ('+")
    a(f, "ft(Math.round(gAvg))+' vs '+ft(Math.round(fAvg))+' in flow). Every interruption charges you a restart fee.</div>'")
    a(f, ":tp<=-5?'<div>Your post-break reads run <b class=""hi"">'+Math.abs(tp)+'% faster</b> \u2014 gaps aren\u2019t costing restart time.</div>'")
    a(f, ":'<div>Post-break reads take about the same as in-flow reads ('+ft(Math.round(gAvg))+' vs '+ft(Math.round(fAvg))+').</div>';}")
    a(f, "if(best)tx+='<div style=""margin-top:9px"">Your most focused solid day was <b>'+esc(best.dt.slice(5))+")
    a(f, "'</b> at <b class=""hi"">'+best.foc+'% focus</b>. That\u2019s the bar to beat.</div>';")
    a(f, "tx+='<div style=""margin-top:9px"">Typical day: <b>'+avgFoc+'% focus</b>, <b>'+Math.round(tIdle/wd.length/60)+")
    a(f, "'m idle</b>. Shrink the red.</div>';")
    a(f, "el('fTax').innerHTML=tx||'<div class=""empty"">Not enough paired reads yet to measure the tax.</div>';}")
    a(f, "/* ---------------- RHYTHM ----------------")
    a(f, "   The question this tab exists to answer: is the length of the day fixed (start")
    a(f, "   earlier, finish earlier) or is the FINISH fixed (start earlier, read more)?")
    a(f, "   The two imply opposite things about what an early start is worth, and only the")
    a(f, "   data can say which one you are. Everything here is associational - the day's")
    a(f, "   workload is not held constant - so the copy says ""tracks"", never ""causes"". */")
    a(f, "var RIB_MAX=24;")
    a(f, "function renderRhythm(dates){")
    a(f, "var DS=dayShape(dates);")
    a(f, "if(DS.length<5){el('rhEmpty').style.display='';el('rhBody').style.display='none';return;}")
    a(f, "el('rhEmpty').style.display='none';el('rhBody').style.display='';")
    a(f, "var starts=DS.map(function(d){return d.st;}),ends=DS.map(function(d){return d.en;});")
    a(f, "var spans=DS.map(function(d){return d.span;});")
    a(f, "var mS=med(starts),mE=med(ends),mSpan=med(spans);")
    a(f, "var iqrE=quant(ends,0.75)-quant(ends,0.25);")
    a(f, "/* ---- your clock ---- */")
    a(f, "function stk2(e,n,l){return '<div class=""stk""><div class=""e"">'+e+'</div><div class=""n"">'+esc(n)+")
    a(f, "'</div><div class=""l"">'+esc(l)+'</div></div>';}")
    a(f, "el('rhStk').innerHTML=stk2('\uD83C\uDF05',hhmm(mS),'median start')+")
    a(f, "stk2('\uD83C\uDF06',hhmm(mE),'median finish')+")
    a(f, "stk2('\u23F1',fh(mSpan*3600),'median day')+")
    a(f, "stk2('\uD83C\uDFAF',Math.round(iqrE*60)+'m','finish spread');")
    a(f, "/* ---- the fit ---- */")
    a(f, "var fit=linfit(starts,ends),line=[];")
    a(f, "if(fit){var x0=Math.min.apply(null,starts),x1=Math.max.apply(null,starts);")
    a(f, "line=[{x:x0,y:fit.b+fit.m*x0},{x:x1,y:fit.b+fit.m*x1}];}")
    a(f, "var hourAx=function(t){var o=ax(t);o.beginAtZero=false;")
    a(f, "o.ticks={callback:function(v){return hhmm(v);}};return o;};")
    a(f, "mk('chRhFit',{type:'scatter',data:{datasets:[")
    a(f, "{label:'Worked day',data:DS.map(function(d){return{x:d.st,y:d.en};}),")
    a(f, "backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,pointRadius:6,pointHoverRadius:10,")
    a(f, "pointHitRadius:14,order:1},")
    a(f, "{label:'Fitted trend',type:'line',data:line,borderColor:MUT,borderWidth:2,borderDash:[5,4],")
    a(f, "pointRadius:0,pointHitRadius:0,fill:false,showLine:true,pointStyle:'line',order:2}]},")
    a(f, "/* LG forces a circle swatch on every entry; here the trend must read as a")
    a(f, "   dashed LINE, so this legend leaves pointStyle to the datasets. */")
    a(f, "options:{plugins:{legend:{position:'bottom',")
    a(f, "labels:{padding:13,usePointStyle:true,boxWidth:14,font:{size:11}}},")
    a(f, "tooltip:{callbacks:{label:function(c){")
    a(f, "if(c.datasetIndex!==0)return 'fitted trend';")
    a(f, "var d=DS[c.dataIndex];")
    a(f, "return d.dt.slice(5)+'  '+hhmm(d.st)+' \u2192 '+hhmm(d.en)+'  ('+fh(d.span*3600)+', '+d.ivu+' IVU)';}}}},")
    a(f, "scales:{x:hourAx('first study opens'),y:hourAx('last study signed')}}});")
    a(f, "el('tvRhFit').innerHTML=tbl(['Date','Day','Start','Finish','Length','Studies','IVU'],")
    a(f, "DS.slice().reverse().map(function(d){return [d.dt,d.dy,hhmm(d.st),hhmm(d.en),")
    a(f, "fh(d.span*3600),d.n,d.ivu];}));")
    a(f, "/* ---- the verdict ----")
    a(f, "   Slope is hours of finish per hour of start. ~1 means the day has a fixed")
    a(f, "   LENGTH; ~0 means it has a fixed END. Those two conclusions point opposite")
    a(f, "   directions, which is the whole reason to measure it rather than assume. */")
    a(f, "/* A slope near 0 is NOT ""no result"" - it is the fixed-end result, and reporting")
    a(f, "   it as noise would bury the more interesting of the two findings. The only")
    a(f, "   genuine no-result cases are too few days, or starts with no spread to fit")
    a(f, "   against. Those are separated out first. */")
    a(f, "var iqrS=quant(starts,0.75)-quant(starts,0.25);")
    a(f, "var v='';")
    a(f, "if(DS.length<8)")
    a(f, "v='<b>Too few days to call it</b> \u2014 '+DS.length+' so far, and this wants 8 or more. '+")
    a(f, "'For now: median start <b>'+hhmm(mS)+'</b>, median finish <b>'+hhmm(mE)+'</b>.';")
    a(f, "else if(!fit||iqrS<0.5)")
    a(f, "v='<b>Your starts barely vary.</b> The middle half of your days begin within <b>'+")
    a(f, "Math.round(iqrS*60)+'m</b> of each other, so there is no spread to read a trend from. '+")
    a(f, "'That is its own answer, though: your start time is already the consistent part.';")
    a(f, "else{")
    a(f, "var perHr=Math.round(fit.m*60),r2=Math.round(fit.r*fit.r*100);")
    a(f, "if(fit.m>=0.7&&r2>=25)")
    a(f, "v='<b>Your day has a fixed length, not a fixed end.</b> Each hour earlier you start, you finish about '+")
    a(f, "'<b class=""hi"">'+perHr+'m earlier</b> \u2014 the start time carries almost straight through. '+")
    a(f, "'Starting early buys you the evening.';")
    a(f, "else if(Math.abs(fit.m)<=0.3)")
    a(f, "v='<b>Your day has a fixed end, not a fixed length.</b> You finish near <b>'+hhmm(mE)+")
    a(f, "'</b> \u2014 the middle half of your days land within <b>'+Math.round(iqrE*60)+'m</b> of each other \u2014 '+")
    a(f, "'almost regardless of when you start; it moves only about '+Math.abs(perHr)+'m per hour. '+")
    a(f, "'So starting an hour earlier does not get you out earlier, it buys you '+")
    a(f, "'<b class=""hi"">an extra hour of reading</b>. Worth doing on purpose rather than by accident.';")
    a(f, "else if(r2>=16)")
    a(f, "v='<b>Partly both.</b> An hour earlier start moves your finish about <b>'+perHr+'m</b> earlier, '+")
    a(f, "'so roughly '+Math.round((1-fit.m)*60)+'m of it turns into extra reading instead of an earlier evening.';")
    a(f, "else")
    a(f, "v='<b>Weak and in between.</b> The trend says '+perHr+'m of finish per hour of start, but it explains '+")
    a(f, "'only '+r2+'% of the variation \u2014 your day length is being set by the workload, not the clock.';")
    a(f, "v+=' <span class=""nt"">'+DS.length+' days, r\u00B2 '+r2+'%.</span>';}")
    a(f, "el('rhVerdict').innerHTML=v;")
    a(f, "/* ---- the ribbon: where each day sat on the clock ---- */")
    a(f, "var rib=DS.slice(-RIB_MAX).reverse();")
    a(f, "el('rhRibD').innerHTML='First study open to last study signed, most recent day at the top.'+")
    a(f, "(DS.length>RIB_MAX?' Showing the latest <b>'+RIB_MAX+'</b> of '+DS.length+' worked days.':'');")
    a(f, "/* Goal outcome rides on the axis LABEL, not the bar fill. Colouring hit/miss")
    a(f, "   green vs red would put the two states 4.1 deltaE apart under deuteranopia -")
    a(f, "   indistinguishable - so the tick carries a check or a cross and the bars stay")
    a(f, "   one validated hue. The glyph works in print and in the table view too. */")
    a(f, "mk('chRhRib',{type:'bar',data:{labels:rib.map(function(d){")
    a(f, "return (d.hit===null?'':(d.hit?'\u2713 ':'\u2717 '))+d.dt.slice(5);}),")
    a(f, "datasets:[{label:'On the clock',data:rib.map(function(d){return [d.st,d.en];}),")
    a(f, "backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,borderRadius:4,maxBarThickness:15}]},")
    a(f, "options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){")
    a(f, "var d=rib[c.dataIndex];")
    a(f, "return hhmm(d.st)+' \u2192 '+hhmm(d.en)+'  ('+fh(d.span*3600)+', '+d.n+' studies, '+d.ivu+' IVU'+")
    a(f, "(d.hit===null?'':(d.hit?', goal hit':', goal missed'))+')';}}}},")
    a(f, "scales:{x:hourAx(''),y:{grid:{display:false},border:{display:false},")
    a(f, "ticks:{maxRotation:0,autoSkip:false,color:function(c){var d=rib[c.index];")
    a(f, "return !d||d.hit===null?MUT:(d.hit?GOODC:CRITC);}}}}}});")
    a(f, "el('tvRhRib').innerHTML=tbl(['Date','Day','Start','Finish','Length','IVU','Goal'],")
    a(f, "rib.map(function(d){return [d.dt,d.dy,hhmm(d.st),hhmm(d.en),fh(d.span*3600),d.ivu,")
    a(f, "d.hit===null?'--':(d.hit?'hit '+r1(d.goal):'missed '+r1(d.goal))];}));")
    a(f, "/* ---- a typical day, by weekday ---- */")
    a(f, "var DOWN=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];")
    a(f, "var bd=DOWN.map(function(nm){")
    a(f, "var dd=DS.filter(function(d){return d.dy.slice(0,3)===nm;});")
    a(f, "return dd.length?{nm:nm,c:dd.length,st:med(dd.map(function(d){return d.st;})),")
    a(f, "en:med(dd.map(function(d){return d.en;})),ivu:med(dd.map(function(d){return d.ivu;}))}:null;})")
    a(f, ".filter(Boolean);")
    a(f, "mk('chRhDow',{type:'bar',data:{labels:bd.map(function(d){return d.nm;}),")
    a(f, "datasets:[{label:'Median start to median finish',data:bd.map(function(d){return [d.st,d.en];}),")
    a(f, "backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,borderRadius:4,maxBarThickness:22}]},")
    a(f, "options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){")
    a(f, "var d=bd[c.dataIndex];")
    a(f, "return hhmm(d.st)+' \u2192 '+hhmm(d.en)+'  (median of '+d.c+' day'+(d.c===1?'':'s')+', '+d.ivu+' IVU)';}}}},")
    a(f, "scales:{x:hourAx(''),y:axX()}}});")
    a(f, "el('tvRhDow').innerHTML=tbl(['Day','Days','Median start','Median finish','Median length','Median IVU'],")
    a(f, "bd.map(function(d){return [d.nm,d.c,hhmm(d.st),hhmm(d.en),fh((d.en-d.st)*3600),d.ivu];}));")
    a(f, "/* ---- what the start time is worth ---- */")
    a(f, "var fSpan=linfit(starts,spans),fIvu=linfit(starts,DS.map(function(d){return d.ivu;}));")
    a(f, "var fDrift=linfit(starts,DS.map(function(d){return d.drift/60;}));")
    a(f, "var nn=[];")
    a(f, "if(fSpan&&Math.abs(fSpan.r)>=0.3){var sm=Math.round(-fSpan.m*60);")
    a(f, "nn.push(sm>0")
    a(f, "?'Starting an hour <b>earlier</b> goes with a day about <b>'+sm+'m longer</b> \u2014 the early time is going into more work, not a shorter day.'")
    a(f, ":'Starting an hour earlier goes with a day about <b>'+Math.abs(sm)+'m shorter</b>.');}")
    a(f, "if(fIvu&&Math.abs(fIvu.r)>=0.3){var im=-fIvu.m;")
    a(f, "if(im>0.05){var t='An hour earlier start goes with <b class=""hi"">+'+r1(im)+' IVU</b> on the day';")
    a(f, "if(FSTAT&&FSTAT.ivu>0)t+=' \u2014 about <b>'+r1(im/FSTAT.ivu)+'</b> '+esc(FSTAT.name)+'s';")
    a(f, "if(LAD)t+=', '+r1(im/LAD.s)+' of a credit';")
    a(f, "nn.push(t+'.');}")
    a(f, "else if(im<-0.05)nn.push('Oddly, later starts go with <b>+'+r1(-im)+' IVU</b> here \u2014 probably the shift mix, not the hour.');}")
    a(f, "if(fDrift&&Math.abs(fDrift.r)>=0.3){var dm=Math.round(fDrift.m);")
    a(f, "if(dm>0)nn.push('Every hour later you start, you drift about <b class=""lo"">'+dm+'m more</b>'+")
    a(f, "(RATE>0?' ('+moneyFor(dm*60)+')':'')+'. Late starts and scattered days travel together.');")
    a(f, "else if(dm<0)nn.push('Later starts actually drift <b>'+Math.abs(dm)+'m less</b> here.');}")
    a(f, "/* Earliest vs latest third - a plain-language version of the same thing, which")
    a(f, "   survives a weak correlation better than a slope does. */")
    a(f, "var srt=DS.slice().sort(function(a,b){return a.st-b.st;}),k=Math.max(1,Math.floor(srt.length/3));")
    a(f, "var early=srt.slice(0,k),late=srt.slice(-k);")
    a(f, "var eI=med(early.map(function(d){return d.ivu;})),lI=med(late.map(function(d){return d.ivu;}));")
    a(f, "var eE=med(early.map(function(d){return d.en;})),lE=med(late.map(function(d){return d.en;}));")
    a(f, "nn.push('Your <b>'+k+' earliest</b> starts (median '+hhmm(med(early.map(function(d){return d.st;})))+")
    a(f, "') finished at '+hhmm(eE)+' with <b>'+r1(eI)+' IVU</b>. Your <b>'+k+' latest</b> (median '+")
    a(f, "hhmm(med(late.map(function(d){return d.st;})))+') finished at '+hhmm(lE)+' with <b>'+r1(lI)+' IVU</b>.');")
    a(f, "el('rhNotes').innerHTML=nn.length")
    a(f, "?'<ul class=""ins"">'+nn.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>'")
    a(f, ":'<div class=""empty"">Nothing tracks your start time strongly enough to report yet.</div>';}")
    a(f, "/* ---------------- BANK ----------------")
    a(f, "   Earnings are DERIVED here from the same CSV the app writes, using the same")
    a(f, "   arithmetic RewardPoints() uses in the .ahk. Nothing about a reward is stored,")
    a(f, "   so it can never drift from the work that produced it. The only persisted")
    a(f, "   fact is a cash-out, because a withdrawal is the one thing the log cannot")
    a(f, "   reconstruct. */")
    a(f, "var RW=(typeof REWARD!=='undefined'&&REWARD)?REWARD:null;")
    a(f, "var CASH=(typeof CASHOUTS!=='undefined'&&CASHOUTS)?CASHOUTS:[];")
    a(f, "function usd2(n){return '$'+(Math.round(n*100)/100).toFixed(2);}")
    a(f, "/* Mirrors RewardPoints() in RadTempo.ahk - keep the two in step. */")
    a(f, "function rwPoints(wins,bets,best,rungs){")
    a(f, "if(!RW)return 0;")
    a(f, "var parPts=wins+(RW.every>0?RW.bonus*Math.floor(best/RW.every):0);")
    a(f, "var goalPts=rungs>0?RW.rung*rungs*(rungs+1)/2:0;")
    a(f, "var mul=0.75+0.5*(bets>0?wins/bets:0);")
    a(f, "return{par:parPts,goal:goalPts,mul:mul,total:parPts+goalPts*mul};}")
    a(f, "/* Per-day bets/wins/best-streak, in log order so a streak means what it says. */")
    a(f, "function rwDays(dates){")
    a(f, "var out=[];")
    a(f, "/* The bank opens on REWARD.start. Without it the first run scores the whole")
    a(f, "   back-catalogue and hands you a balance you never played for - a rebate, not")
    a(f, "   a reward. */")
    a(f, "var from=(RW&&RW.start)?RW.start:'';")
    a(f, "dates.forEach(function(dt){")
    a(f, "if(from&&dt<from)return;")
    a(f, "var dd=V.filter(function(x){return x.date===dt;});")
    a(f, "if(!dd.length)return;")
    a(f, "var bets=0,wins=0,run=0,best=0;")
    a(f, "dd.forEach(function(x){")
    a(f, "if(!(x.par>0&&x.act>=0))return;      /* no bet, no point */")
    a(f, "bets++;")
    a(f, "if(x.act<=x.par){wins++;run++;if(run>best)best=run;}else run=0;});")
    a(f, "var ivu=sumIvu(dd);")
    a(f, "var rungs=credits(ivu);")
    a(f, "var p=rwPoints(wins,bets,best,rungs);")
    a(f, "out.push({dt:dt,dy:dd[0].day,bets:bets,wins:wins,best:best,ivu:r1(ivu),rungs:rungs,")
    a(f, "par:p.par,goalP:p.goal*p.mul,mul:p.mul,pts:p.total,usd:p.total*RW.per});});")
    a(f, "return out;}")
    a(f, "/* ISO-week key, so the weekly cap lands in the same buckets the .ahk uses. */")
    a(f, "function isoWeek(iso){var p=iso.split('-'),d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]));")
    a(f, "var dn=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dn+3);")
    a(f, "var t=new Date(Date.UTC(d.getUTCFullYear(),0,4));")
    a(f, "var wk=1+Math.round(((d-t)/864e5-3+((t.getUTCDay()+6)%7))/7);")
    a(f, "return d.getUTCFullYear()+'-W'+String(wk).padStart(2,'0');}")
    a(f, "function renderBank(dates,DH){")
    a(f, "var body=el('bkBody'),off=el('bkOff');")
    a(f, "if(!body)return;")
    a(f, "if(!RW||!RW.on||!RW.per){off.style.display='';body.style.display='none';return;}")
    a(f, "off.style.display='none';body.style.display='';")
    a(f, "var rows=rwDays(dates);")
    a(f, "/* Apply the weekly cap exactly as the app does, and remember what it cost. */")
    a(f, "var wk={},capped=0,earned=0;")
    a(f, "rows.forEach(function(r){")
    a(f, "var k=isoWeek(r.dt),prev=wk[k]||0,room=RW.cap-prev,amt=r.usd;")
    a(f, "if(room<=0){capped+=amt;r.paid=0;return;}")
    a(f, "if(amt>room){capped+=amt-room;amt=room;}")
    a(f, "wk[k]=prev+amt;r.paid=amt;earned+=amt;});")
    a(f, "var cashed=CASH.reduce(function(a,c){return a+(+c.a||0);},0);")
    a(f, "var bal=Math.max(0,earned-cashed);")
    a(f, "/* hero */")
    a(f, "el('bkBal').textContent=usd2(bal);")
    a(f, "el('bkSub').textContent=usd2(earned)+' earned  \u00B7  '+usd2(cashed)+' taken out';")
    a(f, "var thisWk=isoWeek(TODAY),wkNow=wk[thisWk]||0;")
    a(f, "var side='Cash out from <b>Tray &rarr; Rewards &rarr; Cash Out</b>. It records the withdrawal '+")
    a(f, "'and copies the amount &mdash; buying the card stays your move.';")
    a(f, "if(RW.start)side+='<br><br>Counting from <b>'+esc(RW.start)+'</b>. Anything logged before that '+")
    a(f, "'does not pay &mdash; reset the start date from <b>Rewards &rarr; Start the Bank Today</b>.';")
    a(f, "side+='<br><br>This week: <b>'+usd2(wkNow)+'</b> of the '+usd2(RW.cap)+' cap.';")
    a(f, "if(capped>0.005)side+=' Lifetime, <b>'+usd2(capped)+'</b> was trimmed by that cap.';")
    a(f, "el('bkSide').innerHTML=side;")
    a(f, "/* today */")
    a(f, "var t=rows.filter(function(r){return r.dt===TODAY;})[0];")
    a(f, "var g='';")
    a(f, "function tile2(lb,val,col,sub){return '<div class=""cd""><div class=""lb"">'+esc(lb)+'</div><div class=""vl"" style=""color:'+col+")
    a(f, "'"">'+esc(val)+'</div><div class=""sb"">'+(sub||'')+'</div></div>';}")
    a(f, "if(t){")
    a(f, "g+=tile2('Earned today',usd2(t.paid===undefined?t.usd:t.paid),GOODC,Math.round(t.pts)+' points');")
    a(f, "g+=tile2('Under par',t.wins+'/'+t.bets,t.bets&&t.wins/t.bets>=0.5?GOODC:WARNC,")
    a(f, "t.bets?('best run <b>'+t.best+'</b> \u00B7 '+Math.round(t.wins/t.bets*100)+'%'):'no bets yet');")
    a(f, "g+=tile2('Rungs cleared',t.rungs,t.rungs>0?GOODC:MUT,t.ivu+' IVU'+")
    a(f, "(nextRung(t.ivu)>t.ivu?(' \u00B7 <b>'+r1(nextRung(t.ivu)-t.ivu)+'</b> to the next'):''));")
    a(f, "/* What the next rung is worth, in money. This is the pull. */")
    a(f, "var nr=credits(nextRung(t.ivu));")
    a(f, "if(nr>t.rungs){var bump=rwPoints(t.wins,t.bets,t.best,nr).total-t.pts;")
    a(f, "g+=tile2('Next rung pays',usd2(bump*RW.per),'#c98500','on top of today, at your focus rate');}")
    a(f, "}else{g+=tile2('Earned today',usd2(0),MUT,'nothing signed yet');}")
    a(f, "el('bkToday').innerHTML=g;")
    a(f, "/* the formula, filled in with today (or the most recent day) */")
    a(f, "var f=t||rows[rows.length-1];")
    a(f, "var fh2='';")
    a(f, "if(f){")
    a(f, "function row(cls,l,v){return '<div class=""fmRow '+cls+'""><div class=""fmL"">'+l+'</div><div class=""fmV"">'+v+'</div></div>';}")
    a(f, "fh2+=row('','<b>Par</b> \u2014 1 point per study under par, plus <b>'+RW.bonus+")
    a(f, "'</b> every <b>'+RW.every+'</b> in a row. Flat per win, never scaled by how far under.',")
    a(f, "Math.round(f.par)+' pts');")
    a(f, "fh2+=row('','<b>Goal</b> \u2014 rung '+f.rungs+' of the ladder, '+RW.rung+")
    a(f, "'&times;n(n+1)/2 so each rung pays more than the last.',")
    a(f, "Math.round(f.rungs>0?RW.rung*f.rungs*(f.rungs+1)/2:0)+' pts');")
    a(f, "fh2+=row('mul','<b>Focus multiplier</b> \u2014 your under-par rate, '+")
    a(f, "(f.bets?Math.round(f.wins/f.bets*100):0)+'%. Scales the goal half only.',")
    a(f, "'&times;'+(Math.round(f.mul*100)/100));")
    a(f, "fh2+=row('tot','<b>'+esc(f.dt===TODAY?'Today':f.dt)+'</b> at '+usd2(RW.per)+' per point',")
    a(f, "Math.round(f.pts)+' pts = '+usd2(f.paid===undefined?f.usd:f.paid));}")
    a(f, "el('bkFormula').innerHTML=fh2;")
    a(f, "el('bkNote').innerHTML='A par win pays the same whether you came in ten seconds under or six minutes '+")
    a(f, "'under. Par is <b>engaged</b> time, so a flat token pays you for not drifting; a margin-scaled one '+")
    a(f, "'would put a price on reading faster inside a study, which is the one incentive this app is built to '+")
    a(f, "'avoid. Losing a bet costs nothing \u2014 it just ends the streak.';")
    a(f, "/* chart: stacked par vs goal dollars per day */")
    a(f, "var last=rows.slice(-30);")
    a(f, "el('bkChartD').innerHTML='What each day paid, split into the par half and the goal half'+")
    a(f, "(rows.length>30?'. Showing the latest <b>30</b> of '+rows.length+' days.':'');")
    a(f, "mk('chBank',{type:'bar',data:{labels:last.map(function(r){return r.dt.slice(5);}),")
    a(f, "datasets:[")
    a(f, "{label:'Par',data:last.map(function(r){return Math.round(r.par*RW.per*100)/100;}),")
    a(f, "backgroundColor:SPAL[2],...STACK},")
    a(f, "{label:'Goal',data:last.map(function(r){return Math.round(r.goalP*RW.per*100)/100;}),")
    a(f, "backgroundColor:SPAL[0],...STACK}]},")
    a(f, "options:{plugins:{legend:LG,tooltip:{callbacks:{label:function(c){")
    a(f, "return c.dataset.label+' '+usd2(c.raw);},")
    a(f, "footer:function(items){var r=last[items[0].dataIndex];")
    a(f, "return usd2(r.paid===undefined?r.usd:r.paid)+' total \u00B7 '+r.wins+'/'+r.bets+' under par \u00B7 rung '+r.rungs;}}}},")
    a(f, "scales:{x:Object.assign(axX(),{stacked:true}),")
    a(f, "y:Object.assign(ax('dollars'),{stacked:true,ticks:{callback:function(v){return '$'+v;}}})}}});")
    a(f, "el('tvBank').innerHTML=tbl(['Date','Day','Under par','Best run','IVU','Rung','Mult','Points','Paid'],")
    a(f, "rows.slice().reverse().map(function(r){return [r.dt,r.dy,r.wins+'/'+r.bets,r.best,r.ivu,r.rungs,")
    a(f, "'x'+(Math.round(r.mul*100)/100),Math.round(r.pts),usd2(r.paid===undefined?r.usd:r.paid)];}));")
    a(f, "/* cash-out ledger */")
    a(f, "if(CASH.length){el('bxCash').style.display='';")
    a(f, "el('bkCash').innerHTML=tbl(['When','Amount','Note'],")
    a(f, "CASH.slice().reverse().map(function(c){return [c.d,usd2(+c.a||0),c.n||''];}));}")
    a(f, "else{el('bxCash').style.display='none';}}")
    a(f, "/* ---------------- SHIFTS ---------------- */")
    a(f, "function renderShifts(dates,DH,hasShift,BK,SH,shArr,modRows,mods){")
    a(f, "if(!hasShift||!shArr.length){el('shEmpty').style.display='';el('shBody').style.display='none';return;}")
    a(f, "el('shEmpty').style.display='none';el('shBody').style.display='';")
    a(f, "var lab=shArr.map(function(s){return (s.on?'\u2605 ':'')+(s.name.length>24?s.name.slice(0,22)+'\u2026':s.name);});")
    a(f, "mk('chShift',{type:'bar',data:{labels:lab,datasets:[{label:'IVU per block',data:shArr.map(function(s){return s.ipb;}),")
    a(f, "backgroundColor:SPAL[0],...BAR}]},")
    a(f, "options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{afterBody:function(c){")
    a(f, "var s=shArr[c[0].dataIndex];return 'Blocks: '+s.blocks+'\nStudies/block: '+s.npb+'\nIVU/scheduled hr: '+(s.iph||'--')+")
    a(f, "(s.on?'\nON-SITE':'');}}}},scales:{x:ax('IVU per block'),y:{grid:{display:false},border:{display:false}}}}});")
    a(f, "el('tvShift').innerHTML=tbl(['Block','IVU/blk','Blocks'],shArr.map(function(s){return[s.name,s.ipb,s.blocks];}));")
    a(f, "var tb='';shArr.forEach(function(s){tb+='<tr><td>'+esc(s.name)+'</td><td>'+s.blocks+'</td><td>'+s.n+'</td><td>'+s.npb+")
    a(f, "'</td><td>'+s.ivu+'</td><td class=""tot"">'+s.ipb+'</td><td>'+(s.iph||'--')+'</td><td>'+(s.hrs||'--')+'</td><td>'+")
    a(f, "(s.on?'<span class=""badge"" style=""padding:2px 8px;font-size:9px"">on-site</span>':'')+'</td></tr>';});")
    a(f, "document.querySelector('#tSh tbody').innerHTML=tb;")
    a(f, "/* weekday */")
    a(f, "var dwN=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],dwI={},dwD={};")
    a(f, "dates.forEach(function(dt){var dy=DH[dt].dy;if(!dy)return;dwI[dy]=(dwI[dy]||0)+DH[dt].ivu;dwD[dy]=(dwD[dy]||0)+1;});")
    a(f, "var dwV=dwN.map(function(d){return dwD[d]?Math.round(dwI[d]/dwD[d]*10)/10:0;});")
    a(f, "mk('chDow',{type:'bar',data:{labels:dwN,datasets:[{label:'Avg IVU/day',data:dwV,backgroundColor:SPAL[0],...BAR}]},")
    a(f, "options:{plugins:{legend:{display:false}},scales:{y:ax('IVU'),x:axX()}}});")
    a(f, "el('tvDow').innerHTML=tbl(['Day','Avg IVU'],dwN.map(function(d,i){return[d,dwV[i]];}));")
    a(f, "/* mix */")
    a(f, "var topSh=shArr.slice().sort(function(a,b){return b.blocks-a.blocks;}).slice(0,5).map(function(s){return s.name;});")
    a(f, "var MODL=['CR','CT','MR','US','PET'],mix={};")
    a(f, "topSh.forEach(function(s){mix[s]={};MODL.forEach(function(m){mix[s][m]=0;});});")
    a(f, "V.forEach(function(d){var s=d.shift;if(!s||!mix[s])return;if(mix[s][d.mod]!==undefined)mix[s][d.mod]++;});")
    a(f, "mk('chMix',{type:'bar',data:{labels:topSh.map(function(s){return s.length>20?s.slice(0,18)+'\u2026':s;}),")
    a(f, "datasets:MODL.map(function(m){return{label:MN[m]||m,data:topSh.map(function(s){return Math.round(mix[s][m]/SH[s].blocks*10)/10;}),")
    a(f, "backgroundColor:MC[m],...STACK};})},")
    a(f, "options:{indexAxis:'y',plugins:{legend:LG},scales:{x:Object.assign(ax('studies per block'),{stacked:true}),")
    a(f, "y:{stacked:true,grid:{display:false},border:{display:false}}}}});")
    a(f, "/* cumulative */")
    a(f, "var HRS=[];for(var h=6;h<=20;h++)HRS.push(h);")
    a(f, "var cum={},top4=topSh.slice(0,4);")
    a(f, "top4.forEach(function(s){cum[s]=HRS.map(function(){return 0;});});")
    a(f, "top4.forEach(function(s){var bks=Array.from(new Set(V.filter(function(d){return d.shift===s;}).map(function(d){return d.dRaw;})));")
    a(f, "bks.forEach(function(dr){var c=0;HRS.forEach(function(hh,i){")
    a(f, "V.filter(function(d){return d.dRaw===dr&&d.shift===s&&d.hr===hh;}).forEach(function(d){c+=d.ivu;});cum[s][i]+=c;});});")
    a(f, "var n=bks.length||1;cum[s]=cum[s].map(function(v){return Math.round(v/n*10)/10;});});")
    a(f, "mk('chCum',{type:'line',data:{labels:HRS.map(function(hh){return (hh%12||12)+(hh<12?'a':'p');}),")
    a(f, "datasets:top4.map(function(s,i){return{label:s.length>16?s.slice(0,14)+'\u2026':s,data:cum[s],borderColor:SPAL[i],")
    a(f, "backgroundColor:'transparent',tension:.3,borderWidth:2,pointRadius:0,pointHoverRadius:5,pointHitRadius:24};})},")
    a(f, "options:{plugins:{legend:LG},scales:{y:ax('cumulative IVU'),x:axX()},interaction:{mode:'index',intersect:false}}});")
    a(f, "/* fatigue - split into two single-axis charts */")
    a(f, "var wdays=dates.filter(function(dt){return DH[dt].n>0;}).sort(),pos={},run=[];")
    a(f, "wdays.forEach(function(dt,i){if(i>0&&(new Date(dt)-new Date(wdays[i-1]))===864e5)run.push(dt);else run=[dt];")
    a(f, "pos[dt]=Math.min(run.length,4);});")
    a(f, "var fb={1:{i:0,s:0,n:0,d:0},2:{i:0,s:0,n:0,d:0},3:{i:0,s:0,n:0,d:0},4:{i:0,s:0,n:0,d:0}};")
    a(f, "wdays.forEach(function(dt){var p=pos[dt];fb[p].i+=DH[dt].ivu;fb[p].d++;")
    a(f, "var rows=V.filter(function(d){return d.date===dt;});")
    a(f, "fb[p].s+=rows.reduce(function(a,r){return a+r.sec;},0);fb[p].n+=rows.length;});")
    a(f, "var fatL=['Day 1','Day 2','Day 3','Day 4+'];")
    a(f, "mk('chFatI',{type:'bar',data:{labels:fatL,datasets:[{label:'IVU/day',")
    a(f, "data:[1,2,3,4].map(function(p){return fb[p].d?Math.round(fb[p].i/fb[p].d*10)/10:null;}),backgroundColor:SPAL[0],...BAR}]},")
    a(f, "options:{plugins:{legend:{display:false}},scales:{y:ax('IVU per day'),x:axX()}}});")
    a(f, "mk('chFatS',{type:'bar',data:{labels:fatL,datasets:[{label:'sec/study',")
    a(f, "data:[1,2,3,4].map(function(p){return fb[p].n?Math.round(fb[p].s/fb[p].n):null;}),backgroundColor:SPAL[3],...BAR}]},")
    a(f, "options:{plugins:{legend:{display:false}},scales:{y:ax('seconds per study'),x:axX()}}});")
    a(f, "/* trend */")
    a(f, "var sel=el('shSel');sel.innerHTML='';")
    a(f, "shArr.forEach(function(s){var o=document.createElement('option');o.value=s.name;")
    a(f, "o.textContent=s.name+' ('+s.blocks+' blocks)';sel.appendChild(o);});")
    a(f, "function shTrend(name){var bks=Object.values(BK).filter(function(b){return b.shift===name;})")
    a(f, ".sort(function(a,x){return new Date(a.date)-new Date(x.date);});")
    a(f, "var vals=bks.map(function(b){return Math.round(b.ivu*10)/10;}),ra=[],su=0;")
    a(f, "vals.forEach(function(v,i){su+=v;ra.push(Math.round(su/(i+1)*10)/10);});")
    a(f, "mk('chShTrend',{data:{labels:bks.map(function(b){var p=b.date.split('/');return p[0]+'/'+p[1];}),")
    a(f, "datasets:[{type:'bar',label:'IVU',data:vals,backgroundColor:SPAL[0],...BAR,order:2},")
    a(f, "{type:'line',label:'Running avg',data:ra,borderColor:SPAL[3],backgroundColor:'transparent',borderWidth:2,")
    a(f, "pointRadius:0,pointHoverRadius:5,pointHitRadius:24,tension:.3,order:1}]},")
    a(f, "options:{plugins:{legend:LG},scales:{y:ax('IVU'),x:axX()},interaction:{mode:'index',intersect:false}}});}")
    a(f, "sel.onchange=function(e){shTrend(e.target.value);};")
    a(f, "if(shArr.length)shTrend(shArr[0].name);")
    a(f, "/* modifier */")
    a(f, "if(modRows.length){el('bxMod').style.display='';var mb='';")
    a(f, "modRows.forEach(function(r){mb+='<tr><td>'+esc(r.m)+'</td><td>'+r.bw+'</td><td>'+r.iw+'</td><td>'+r.io+")
    a(f, "'</td><td class=""'+(r.d>=0?'up':'dn')+'"" style=""font-weight:700"">'+(r.d>0?'+':'')+r.d+'%</td></tr>';});")
    a(f, "document.querySelector('#tMod tbody').innerHTML=mb;}else el('bxMod').style.display='none';")
    a(f, "/* same exam different shift */")
    a(f, "var xsMap={};")
    a(f, "V.forEach(function(d){var s=d.shift;if(!s||!d.exam)return;var k=d.exam;")
    a(f, "if(!xsMap[k])xsMap[k]={tot:0,sh:{}};xsMap[k].tot++;")
    a(f, "if(!xsMap[k].sh[s])xsMap[k].sh[s]={sum:0,n:0};xsMap[k].sh[s].sum+=d.sec;xsMap[k].sh[s].n++;});")
    a(f, "var xsEx=Object.keys(xsMap).map(function(k){return{name:k,tot:xsMap[k].tot,")
    a(f, "ns:Object.values(xsMap[k].sh).filter(function(v){return v.n>=3;}).length};})")
    a(f, ".filter(function(e){return e.ns>=2;}).sort(function(a,b){return b.tot-a.tot;}).slice(0,6);")
    a(f, "if(xsEx.length){el('bxXS').style.display='';var xsSh=topSh.slice(0,4);")
    a(f, "var xh='<tr><th>Exam</th>';xsSh.forEach(function(s){xh+='<th>'+esc(s.length>14?s.slice(0,12)+'\u2026':s)+'</th>';});")
    a(f, "document.querySelector('#tXS thead').innerHTML=xh+'</tr>';")
    a(f, "var xb='';")
    a(f, "xsEx.forEach(function(e){var cells=xsSh.map(function(s){var c=xsMap[e.name].sh[s];return c&&c.n>=3?Math.round(c.sum/c.n):null;});")
    a(f, "var vv=cells.filter(function(v){return v!==null;}),mn=Math.min.apply(null,vv),mx=Math.max.apply(null,vv);")
    a(f, "xb+='<tr><td>'+esc(e.name.length>40?e.name.slice(0,38)+'\u2026':e.name)+'</td>';")
    a(f, "cells.forEach(function(v){if(v===null){xb+='<td class=""nt"">--</td>';return;}")
    a(f, "var cl=(v===mn&&vv.length>1)?'up':(v===mx&&vv.length>1?'dn':'');")
    a(f, "xb+='<td class=""'+cl+'"" style=""font-weight:650"">'+ft(v)+'</td>';});xb+='</tr>';});")
    a(f, "document.querySelector('#tXS tbody').innerHTML=xb;}else el('bxXS').style.display='none';")
    a(f, "/* insights */")
    a(f, "var INS=[],elig=shArr.filter(function(s){return s.blocks>=3;});")
    a(f, "if(elig.length>=2){var hi=elig[0],lo=elig[elig.length-1];")
    a(f, "INS.push('<b>'+esc(hi.name)+'</b> is your highest-yield block at <span class=""hi"">'+hi.ipb+' IVU/block</span> \u2014 '+")
    a(f, "(lo.ipb>0?Math.round((hi.ipb/lo.ipb-1)*100):0)+'% above <b>'+esc(lo.name)+'</b> ('+lo.ipb+').');}")
    a(f, "var effSh=elig.filter(function(s){return s.iph>0;}).sort(function(a,b){return b.iph-a.iph;});")
    a(f, "if(effSh.length>=2)INS.push('Per <i>scheduled</i> hour, <b>'+esc(effSh[0].name)+'</b> leads at <span class=""hi"">'+")
    a(f, "effSh[0].iph+' IVU/hr</span>; <b>'+esc(effSh[effSh.length-1].name)+'</b> trails at <span class=""lo"">'+effSh[effSh.length-1].iph+'</span>.');")
    a(f, "var onB=shArr.filter(function(s){return s.on&&s.blocks>=2;}),offB=shArr.filter(function(s){return !s.on&&s.blocks>=2;});")
    a(f, "if(onB.length&&offB.length){var oi=onB.reduce(function(a,s){return a+s.ivu;},0)/onB.reduce(function(a,s){return a+s.blocks;},0);")
    a(f, "var ri=offB.reduce(function(a,s){return a+s.ivu;},0)/offB.reduce(function(a,s){return a+s.blocks;},0);")
    a(f, "var dp=Math.round((oi/ri-1)*100);")
    a(f, "INS.push('<b>On-site blocks</b> run <span class=""'+(dp>=0?'hi':'lo')+'"">'+(dp>0?'+':'')+dp+'%</span> IVU/block vs remote.');}")
    a(f, "if(modRows.length)INS.push('Biggest modifier effect: <b>'+esc(modRows[0].m)+'</b> blocks run <span class=""'+")
    a(f, "(modRows[0].d>=0?'hi':'lo')+'"">'+(modRows[0].d>0?'+':'')+modRows[0].d+'%</span> vs the same blocks without it.');")
    a(f, "if(fb[1].d>=3&&fb[3].d+fb[4].d>=3){var d1=fb[1].i/fb[1].d,late=(fb[3].i+fb[4].i)/(fb[3].d+fb[4].d);")
    a(f, "var fp=Math.round((late/d1-1)*100);")
    a(f, "INS.push(fp<=-5?'Output drops <span class=""lo"">'+Math.abs(fp)+'%</span> by day 3+ of a stretch \u2014 front-load heavy lists early.'")
    a(f, ":fp>=5?'You ramp up across a stretch: day 3+ runs <span class=""hi"">'+fp+'%</span> above day 1.'")
    a(f, ":'Consistent across stretches: day 3+ is within '+Math.abs(fp)+'% of day 1.');}")
    a(f, "if(INS.length){el('bxIns').style.display='';el('insList').innerHTML=INS.map(function(t){return '<li>'+t+'</li>';}).join('');}")
    a(f, "else el('bxIns').style.display='none';")
    a(f, "/* forecast */")
    a(f, "if(HASSH&&HASCLS){var shipd={};shArr.forEach(function(s){shipd[s.name]={ipb:s.ipb,npb:s.npb,d:s.blocks};});")
    a(f, "var modD={};modRows.forEach(function(r){modD[r.m]=r.d/100;});")
    a(f, "var allBk=Object.keys(BK).length;")
    a(f, "var allIpb=allBk?Object.values(BK).reduce(function(a,b){return a+b.ivu;},0)/allBk:0;")
    a(f, "var allNpb=allBk?Object.values(BK).reduce(function(a,b){return a+b.n;},0)/allBk:0;")
    a(f, "var rows=[],wk7=0,now=new Date();")
    a(f, "for(var i=1;i<=14;i++){var dd=new Date(now.getTime()+i*864e5),key=mdyOf(dd),raw=SHIFTS[key];")
    a(f, "if(!raw)continue;var pm=dayPlan(raw),P=pm[0],M=pm[1];if(!P.length)continue;")
    a(f, "var dI=0,dN=0,parts=[],est=true;")
    a(f, "P.forEach(function(p){var st=shipd[p.name],eI=st&&st.d>=2?st.ipb:allIpb,eN=st&&st.d>=2?st.npb:allNpb;")
    a(f, "if(!(st&&st.d>=2))est=false;")
    a(f, "M.forEach(function(m){var mb=modBase(m.name),ov=!m.w||!p.w||(m.s<p.e&&p.s<m.e);")
    a(f, "if(ov&&modD[mb]!==undefined)eI*=(1+modD[mb]);});")
    a(f, "dI+=eI;dN+=eN;parts.push((p.on?'\u2605':'')+(p.name.length>18?p.name.slice(0,16)+'\u2026':p.name));});")
    a(f, "if(i<=7)wk7+=dI;")
    a(f, "rows.push({key:key,dy:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dd.getDay()],parts:parts.join('  +  '),")
    a(f, "eI:Math.round(dI*10)/10,eN:Math.round(dN*10)/10,est:est});}")
    a(f, "if(rows.length){el('bxFc').style.display='';")
    a(f, "el('fcSum').textContent='Projected next 7 days: ~'+(Math.round(wk7*10)/10)+' IVU';")
    a(f, "var fb2='';rows.forEach(function(r){fb2+='<tr><td>'+esc(r.key)+'</td><td>'+esc(r.dy)+'</td><td>'+esc(r.parts)+")
    a(f, "'</td><td>'+r.eN+'</td><td class=""tot"">'+r.eI+(r.est?'':' <span class=""nt"">(est)</span>')+'</td></tr>';});")
    a(f, "document.querySelector('#tFc tbody').innerHTML=fb2;}else el('bxFc').style.display='none';}}")
    a(f, "/* ---------------- EXAMS ---------------- */")
    a(f, "function renderExams(mods){")
    a(f, "var mc='';")
    a(f, "mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});if(!md.length)return;")
    a(f, "var avg=Math.round(md.reduce(function(a,d){return a+d.sec;},0)/md.length);")
    a(f, "var matched=md.filter(function(d){return d.ivu>0;});")
    a(f, "var mIvu=matched.reduce(function(a,d){return a+d.ivu;},0);")
    a(f, "var mAvgIvu=matched.length?Math.round(mIvu/matched.length*100)/100:0;")
    a(f, "var mAvgSec=md.reduce(function(a,d){return a+d.sec;},0)/md.length;")
    a(f, "var perMin=mAvgSec>0?Math.round(mAvgIvu/(mAvgSec/60)*100)/100:0;")
    a(f, "var tr='<span class=""nt"">--</span>';")
    a(f, "if(md.length>=10){var f5=md.slice(0,5).reduce(function(a,d){return a+d.sec;},0)/5;")
    a(f, "var l5=md.slice(-5).reduce(function(a,d){return a+d.sec;},0)/5,df=Math.round(f5-l5);")
    a(f, "tr=df>5?'<span class=""up"">'+ft(Math.abs(df))+' faster</span>':df<-5?'<span class=""dn"">'+ft(Math.abs(df))+' slower</span>':'<span class=""nt"">steady</span>';}")
    a(f, "mc+='<div class=""cd""><div class=""lb""><span class=""mb '+esc(m)+'"" style=""padding:1px 6px;font-size:9px"">'+esc(m)+'</span> '+")
    a(f, "esc(MN[m]||m)+'</div><div class=""vl"">'+ft(avg)+'</div><div class=""sb"">'+md.length+' studies \u00B7 '+tr+")
    a(f, "'</div><div class=""sb"">IVU <b>'+(Math.round(mIvu*10)/10)+'</b> \u00B7 avg <b>'+mAvgIvu+'</b> \u00B7 <b>'+perMin+'</b>/min</div></div>';});")
    a(f, "el('mc').innerHTML=mc;")
    a(f, "/* efficiency */")
    a(f, "var eff=[];")
    a(f, "mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});if(!md.length)return;")
    a(f, "var totalSec=md.reduce(function(a,d){return a+d.sec;},0);")
    a(f, "var matched=md.filter(function(d){return d.ivu>0;});")
    a(f, "var totalIvu=matched.reduce(function(a,d){return a+d.ivu;},0);")
    a(f, "var avgSec=totalSec/md.length,avgIvu=matched.length?totalIvu/matched.length:0;")
    a(f, "eff.push({mod:m,perMin:avgSec>0?Math.round(avgIvu/(avgSec/60)*1000)/1000:0,")
    a(f, "avgIvu:Math.round(avgIvu*100)/100,avgSec:Math.round(avgSec),count:md.length,hrs:Math.round(totalSec/360)/10});});")
    a(f, "eff.sort(function(a,b){return b.perMin-a.perMin;});")
    a(f, "mk('chIVUEff',{type:'bar',data:{labels:eff.map(function(d){return MN[d.mod]||d.mod;}),")
    a(f, "datasets:[{label:'IVU/min',data:eff.map(function(d){return d.perMin;}),")
    a(f, "backgroundColor:eff.map(function(d){return MC[d.mod];}),...BAR}]},")
    a(f, "options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{afterBody:function(c){var d=eff[c[0].dataIndex];")
    a(f, "return 'Avg IVU/study: '+d.avgIvu+'\nAvg time: '+ft(d.avgSec)+'\nStudies: '+d.count+'\nActive: '+d.hrs+'h';}}}},")
    a(f, "scales:{x:ax('IVU per minute of reading'),y:{grid:{display:false},border:{display:false}}}}});")
    a(f, "el('tvEff').innerHTML=tbl(['Modality','IVU/min','Avg IVU','Avg time','Studies'],")
    a(f, "eff.map(function(d){return[MN[d.mod]||d.mod,d.perMin,d.avgIvu,ft(d.avgSec),d.count];}));")
    a(f, "/* study types */")
    a(f, "var stMap={};")
    a(f, "V.forEach(function(d){if(!d.exam||d.exam.length<3)return;")
    a(f, "if(!stMap[d.exam])stMap[d.exam]={mod:d.mod,times:[],ivus:[]};")
    a(f, "stMap[d.exam].times.push(d.sec);if(d.ivu>0)stMap[d.exam].ivus.push(d.ivu);});")
    a(f, "var full=Object.keys(stMap).map(function(k){var m=stMap[k];")
    a(f, "var avgT=m.times.reduce(function(a,b){return a+b;},0)/m.times.length;")
    a(f, "var avgI=m.ivus.length?m.ivus.reduce(function(a,b){return a+b;},0)/m.ivus.length:0;")
    a(f, "return{name:k,mod:m.mod,count:m.times.length,avg:Math.round(avgT),avgIvu:Math.round(avgI*100)/100,")
    a(f, "ivuMin:avgT>0?Math.round(avgI/(avgT/60)*1000)/1000:0};}).sort(function(a,b){return b.count-a.count;});")
    a(f, "var arr=full.slice(),dir=1,filt='ALL';")
    a(f, "function renderST(){var tb=document.querySelector('#tST tbody');")
    a(f, "if(!arr.length){tb.innerHTML='<tr><td colspan=""6"" class=""nt"" style=""text-align:center;padding:22px"">No studies match</td></tr>';return;}")
    a(f, "var mx=Math.max.apply(null,arr.map(function(s){return s.ivuMin;}));")
    a(f, "var h='';arr.forEach(function(s){var p=mx>0?Math.round(s.ivuMin/mx*100):0;")
    a(f, "var cl=p>=75?'up':p>=50?'':'nt';")
    a(f, "h+='<tr data-n=""'+esc(s.name)+'"" style=""cursor:pointer""><td>'+esc(s.name)+'</td><td><span class=""mb '+esc(s.mod)+")
    a(f, "'"">'+esc(s.mod)+'</span></td><td>'+s.count+'</td><td style=""color:#c98500;font-weight:650"">'+ft(s.avg)+")
    a(f, "'</td><td class=""tot"">'+s.avgIvu+'</td><td class=""'+cl+'"" style=""font-weight:650"">'+s.ivuMin.toFixed(3)+'</td></tr>';});")
    a(f, "tb.innerHTML=h;")
    a(f, "Array.prototype.forEach.call(tb.querySelectorAll('tr'),function(r){r.onclick=function(){")
    a(f, "var n=r.getAttribute('data-n');if(n){el('stSel').value=n;trend(n);}};});}")
    a(f, "el('stModFilter').onchange=function(e){filt=e.target.value;")
    a(f, "arr=filt==='ALL'?full.slice():full.filter(function(s){return s.mod===filt;});renderST();};")
    a(f, "Array.prototype.forEach.call(document.querySelectorAll('#tST thead th'),function(th){")
    a(f, "th.style.cursor='pointer';th.onclick=function(){var k=['name','mod','count','avg','avgIvu','ivuMin'][+th.getAttribute('data-s')];")
    a(f, "arr.sort(function(a,b){var x=a[k],y=b[k];return typeof x==='string'?dir*x.localeCompare(y):dir*(x-y);});dir*=-1;renderST();};});")
    a(f, "renderST();")
    a(f, "var ss=el('stSel');ss.innerHTML='';")
    a(f, "full.forEach(function(s){var o=document.createElement('option');o.value=s.name;")
    a(f, "o.textContent=s.name+' ('+s.count+')';ss.appendChild(o);});")
    a(f, "function trend(name){var e=V.filter(function(d){return (d.exam||'').trim()===name;});if(!e.length)return;")
    a(f, "var times=e.map(function(d){return d.sec;}),ra=[],su=0;")
    a(f, "times.forEach(function(t,i){su+=t;ra.push(Math.round(su/(i+1)));});")
    a(f, "var avg=Math.round(times.reduce(function(a,b){return a+b;},0)/times.length);")
    a(f, "/* past ~20 reads a bar per study becomes a barcode - switch to a line */")
    a(f, "var many=times.length>20;")
    a(f, "var perStudy=many")
    a(f, "?{type:'line',label:'Time',data:times,borderColor:SPAL[2],backgroundColor:'rgba(25,158,112,.10)',fill:true,")
    a(f, "borderWidth:2,tension:.25,pointRadius:0,pointHoverRadius:5,pointHitRadius:24,order:3}")
    a(f, ":{type:'bar',label:'Time',data:times,backgroundColor:SPAL[2],...BAR,order:3};")
    a(f, "mk('chSTrend',{data:{labels:e.map(function(d,i){return many?d.date.slice(5):(d.date.slice(5)+' #'+(i+1));}),")
    a(f, "datasets:[perStudy,")
    a(f, "{type:'line',label:'Running avg',data:ra,borderColor:SPAL[3],backgroundColor:'transparent',borderWidth:2,")
    a(f, "pointRadius:0,pointHoverRadius:5,pointHitRadius:24,tension:.3,order:1}]},")
    a(f, "options:{plugins:{legend:LG,title:{display:true,text:name+' \u2014 '+e.length+' studies, avg '+ft(avg),")
    a(f, "color:'#b8b8cf',font:{size:12}}},scales:{y:Object.assign(ax('seconds'),{ticks:{callback:function(v){return ft(v);}}}),")
    a(f, "x:Object.assign(axX(),{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:6}})},")
    a(f, "interaction:{mode:'index',intersect:false}}});}")
    a(f, "ss.onchange=function(e){trend(e.target.value);};")
    a(f, "if(full.length)trend(full[0].name);}")
    a(f, "/* ---------------- LOG ---------------- */")
    a(f, "function renderLog(dates,DH,mods){")
    a(f, "var ivByDate={};dates.forEach(function(dt){ivByDate[dt]=DH[dt].ivu;});")
    a(f, "var bIvD='',bIvV=0;Object.keys(ivByDate).forEach(function(k){if(ivByDate[k]>bIvV){bIvV=ivByDate[k];bIvD=k;}});")
    a(f, "var bVoD='',bVoV=0,bAcD='',bAcV=0;")
    a(f, "Object.keys(DH).forEach(function(k){if(DH[k].n>bVoV){bVoV=DH[k].n;bVoD=k;}if(DH[k].a>bAcV){bAcV=DH[k].a;bAcD=k;}});")
    a(f, "var hC=new Array(24).fill(0);V.forEach(function(d){hC[d.hr]++;});")
    a(f, "var pk=0;hC.forEach(function(v,i){if(v>hC[pk])pk=i;});")
    a(f, "var rc='';")
    a(f, "function rec(lb,val,sub){return '<div class=""cd""><div class=""lb"">'+esc(lb)+'</div><div class=""vl"">'+esc(val)+")
    a(f, "'</div><div class=""sb"">'+esc(sub)+'</div></div>';}")
    a(f, "rc+=rec('Best IVU day',Math.round(bIvV*10)/10,bIvD);")
    a(f, "rc+=rec('Most studies',bVoV,bVoD);")
    a(f, "rc+=rec('Longest active day',fh(bAcV),bAcD);")
    a(f, "rc+=rec('Peak hour',(pk%12||12)+(pk<12?' AM':' PM'),hC[pk]+' studies signed');")
    a(f, "el('rc').innerHTML=rc;")
    a(f, "var L=dates.map(function(d){return d.slice(5);});")
    a(f, "var dBM={};mods.forEach(function(m){dBM[m]={};});")
    a(f, "V.forEach(function(d){if(dBM[d.mod])dBM[d.mod][d.date]=(dBM[d.mod][d.date]||0)+1;});")
    a(f, "mk('chVol',{type:'bar',data:{labels:L,datasets:mods.map(function(m){return{label:MN[m]||m,")
    a(f, "data:dates.map(function(d){return dBM[m][d]||0;}),backgroundColor:MC[m]||'#888',...STACK};})},")
    a(f, "options:{plugins:{legend:LG},scales:{x:Object.assign(axX(),{stacked:true}),y:Object.assign(ax('studies'),{stacked:true})}}});")
    a(f, "var ivBM={};mods.forEach(function(m){ivBM[m]={};});")
    a(f, "V.forEach(function(d){if(d.ivu>0&&ivBM[d.mod])ivBM[d.mod][d.date]=(ivBM[d.mod][d.date]||0)+d.ivu;});")
    a(f, "mk('chIVU',{type:'bar',data:{labels:L,datasets:mods.map(function(m){return{label:MN[m]||m,")
    a(f, "data:dates.map(function(d){return Math.round((ivBM[m][d]||0)*100)/100;}),backgroundColor:MC[m]||'#888',...STACK};})},")
    a(f, "options:{plugins:{legend:LG},scales:{x:Object.assign(axX(),{stacked:true}),y:Object.assign(ax('IVU'),{stacked:true})}}});")
    a(f, "var eD=[],eA=[],eO=[],eP=[];")
    a(f, "dates.forEach(function(dt){var d=DH[dt];if(d.n<2)return;")
    a(f, "eD.push(dt.slice(5));eA.push(fhr(d.a));eO.push(fhr(d.o));eP.push(d.o>0?Math.round(d.a/d.o*100):0);});")
    a(f, "mk('chEff',{type:'bar',data:{labels:eD,datasets:[")
    a(f, "{label:'On-clock',data:eO,backgroundColor:'#2b2b52',...BAR},")
    a(f, "{label:'Active',data:eA,backgroundColor:SPAL[3],...BAR}]},")
    a(f, "options:{plugins:{legend:LG,tooltip:{callbacks:{afterBody:function(c){return 'Efficiency: '+eP[c[0].dataIndex]+'%';}}}},")
    a(f, "scales:{y:ax('hours'),x:axX()}}});")
    a(f, "mk('chHr',{type:'bar',data:{labels:hC.map(function(_,i){return (i%12||12)+(i<12?'a':'p');}),")
    a(f, "datasets:[{label:'Studies',data:hC,backgroundColor:hC.map(function(v,i){return i===pk?SPAL[3]:'#2b2b52';}),")
    a(f, "borderRadius:3,maxBarThickness:16}]},")
    a(f, "options:{plugins:{legend:{display:false}},scales:{y:ax('studies'),x:axX()}}});")
    a(f, "var wks={};")
    a(f, "V.forEach(function(d){var dt=new Date(d.date);")
    a(f, "var wn=d.date.slice(0,4)+'-W'+String(Math.ceil(((dt-new Date(dt.getFullYear(),0,1))/864e5+1)/7)).padStart(2,'0');")
    a(f, "if(!wks[wn])wks[wn]={n:0,sec:0};wks[wn].n++;wks[wn].sec+=d.sec;});")
    a(f, "var wk=Object.keys(wks).sort();")
    a(f, "mk('chWkN',{type:'bar',data:{labels:wk,datasets:[{label:'Studies',data:wk.map(function(w){return wks[w].n;}),")
    a(f, "backgroundColor:SPAL[2],...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('studies'),x:axX()}}});")
    a(f, "mk('chWkH',{type:'bar',data:{labels:wk,datasets:[{label:'Active hours',data:wk.map(function(w){return fhr(wks[w].sec);}),")
    a(f, "backgroundColor:SPAL[0],...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('hours'),x:axX()}}});")
    a(f, "var dh='';")
    a(f, "dates.slice().reverse().forEach(function(dt){var d=DH[dt],ef=d.o>0?Math.round(d.a/d.o*100):0;")
    a(f, "var ec=ef>=70?'up':ef>=50?'':'dn';")
    a(f, "dh+='<tr><td>'+esc(dt)+'</td><td class=""nt"">'+esc(d.dy||'')+'</td><td style=""color:#fff;font-weight:650"">'+d.n+")
    a(f, "'</td><td style=""color:#c98500"">'+fh(d.a)+'</td><td>'+fh(d.o)+'</td><td class=""'+(d.idle>=600?'dn':'')+'"">'+")
    a(f, "Math.round(d.idle/60)+'m</td><td class=""'+(d.idle>=600?'dn':'nt')+'"">'+(RATE>0?moneyFor(d.idle):'--')+")
    a(f, "'</td><td class=""'+ec+'"" style=""font-weight:650"">'+ef+'%</td><td class=""tot"">'+")
    a(f, "(Math.round(d.ivu*100)/100)+'</td></tr>';});")
    a(f, "document.querySelector('#tDH tbody').innerHTML=dh;")
    a(f, "var mA={};mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});")
    a(f, "mA[m]=md.length?Math.round(md.reduce(function(a,d){return a+d.sec;},0)/md.length):0;});")
    a(f, "var rh='';")
    a(f, "V.slice(-40).reverse().forEach(function(d){var df=d.sec-(mA[d.mod]||0),vs;")
    a(f, "if(Math.abs(df)<=5)vs='<span class=""nt"">avg</span>';")
    a(f, "else if(df<0)vs='<span class=""up"">'+ft(Math.abs(df))+' faster</span>';")
    a(f, "else vs='<span class=""dn"">'+ft(df)+' slower</span>';")
    a(f, "rh+='<tr><td>'+esc(d.ts)+'</td><td><span class=""mb '+esc(d.mod)+'"">'+esc(d.mod)+'</span></td><td>'+")
    a(f, "esc((d.exam||'').slice(0,38))+'</td><td style=""color:#fff;font-weight:650"">'+esc(d.fmt)+'</td><td>'+vs+'</td><td class=""'+")
    a(f, "(d.ivu>0?'tot':'nt')+'"">'+(d.ivu>0?Math.round(d.ivu*100)/100:'--')+'</td></tr>';});")
    a(f, "document.querySelector('#tR tbody').innerHTML=rh;}")
    a(f, "/* ---------------- wiring ---------------- */")
    a(f, "Array.prototype.forEach.call(document.querySelectorAll('#tabs button'),function(b){")
    a(f, "b.onclick=function(){Array.prototype.forEach.call(document.querySelectorAll('#tabs button'),function(x){")
    a(f, "x.setAttribute('aria-selected',x===b?'true':'false');});")
    a(f, "Array.prototype.forEach.call(document.querySelectorAll('.pane'),function(p){")
    a(f, "p.classList.toggle('on',p.id==='p-'+b.getAttribute('data-p'));});")
    a(f, "window.scrollTo({top:0,behavior:'smooth'});};});")
    a(f, "Array.prototype.forEach.call(document.querySelectorAll('#rng button'),function(b){")
    a(f, "b.onclick=function(){RANGE=+b.getAttribute('data-d');")
    a(f, "Array.prototype.forEach.call(document.querySelectorAll('#rng button'),function(x){")
    a(f, "x.setAttribute('aria-pressed',x===b?'true':'false');});render();")
    a(f, "/* Today is always just today: a range is shown on the history tabs */")
    a(f, "var td=document.getElementById('p-today');if(td&&td.classList.contains('on')){var fb=document.querySelector('#tabs button[data-p=""focus""]');if(fb)fb.click();}};});")
    a(f, "document.addEventListener('click',function(e){var t=e.target;")
    a(f, "if(t&&t.classList&&t.classList.contains('tgl')){var id=t.getAttribute('data-tv'),n=el(id);")
    a(f, "if(n){n.classList.toggle('on');t.textContent=n.classList.contains('on')?'Hide table':'Table view';}}});")
    a(f, "(function(){var all=document.querySelectorAll('#rng button');")
    a(f, "Array.prototype.forEach.call(all,function(b){")
    a(f, "b.setAttribute('aria-pressed',(+b.getAttribute('data-d'))===RANGE?'true':'false');});})();")
    a(f, "render();")
    a(f, "}catch(e){console.error('Dashboard error:',e);")
    a(f, "document.body.insertAdjacentHTML('afterbegin','<div style=""color:#d03b3b;padding:14px;background:#1c1c3a;margin:10px;border-radius:10px"">Dashboard error: '+e.message+'</div>');}")
    a(f, "</script></body></html>")
    ; ==== END generated dashboard ====

    Run, %DASH_FILE%
}

; Comma list -> JSON string array (uppercased keys)
CsvToJsonArr(list) {
    out := "["
    first := true
    Loop, Parse, list, `,
    {
        k := Trim(A_LoopField)
        if (k = "")
            continue
        StringUpper, k, k
        StringReplace, k, k, \, \\, All
        StringReplace, k, k, ", \", All
        if (!first)
            out .= ","
        out .= """" . k . """"
        first := false
    }
    return out . "]"
}

; Helper: append a line to a file (uses FileOpen to avoid % expansion)
a(file, text) {
    fh := FileOpen(file, "a", "UTF-8-RAW")
    if IsObject(fh) {
        fh.Write(text . "`n")
        fh.Close()
    }
}
; ============================================================
;  TRAY HANDLERS
; ============================================================

MenuShow:
    Gui, Main:Show
return

MenuReposition:
    SnapToCorner()
return

MenuDashboard:
    GenerateDashboard()
return

MenuResetCount:
    todayCount := 0
    todayIVU := 0.00
    todayIVU_CR := 0.00
    todayIVU_CT := 0.00
    todayIVU_MR := 0.00
    todayIVU_US := 0.00
    todayIVU_PET := 0.00
    GuiControl, Main:, CountDisplay, 0
    GuiControl, Main:, IVUDisplay, 0.0
    Menu, Tray, Tip, RadTempo
return

MenuTestStart:
    GoSub, DoStart
return

MenuTestStop:
    GoSub, DoStop
return

MenuTestWellness:
    ShowWellnessCard("nudge")
return

MenuWellnessStatus:
    ShowWellnessCard("status")
return

MenuFindPACS:
    ; Diagnostic - shows controls in the LAST detected PACS window.
    if (lastPACSWin = 0 || !WinExist("ahk_id " . lastPACSWin)) {
        MsgBox, 48, PACS Diagnostic, No PACS window detected yet.`n`nClick on your PACS worklist, wait 2 seconds, then try this menu again.
        return
    }

    pacsWin := "ahk_id " . lastPACSWin
    WinGet, pacsExe, ProcessName, %pacsWin%
    WinGetTitle, pacsTitle, %pacsWin%
    WinGet, ctrlList, ControlList, %pacsWin%

    info := "PACS WINDOW DIAGNOSTIC`n"
    info .= "----------------------------------------`n"
    info .= "Process: " . pacsExe . "`n"
    info .= "Title: " . pacsTitle . "`n"
    info .= "HWND: " . lastPACSWin . "`n"
    info .= "----------------------------------------`n"

    ; Find ALL SysListView32 controls and show details for each
    info .= "ALL SysListView32 controls:`n`n"
    listCount := 0
    Loop, Parse, ctrlList, `n
    {
        if (A_LoopField = "")
            continue
        if !InStr(A_LoopField, "SysListView32")
            continue
        listCount++
        ControlGet, sel, List, Selected, %A_LoopField%, %pacsWin%
        ControlGet, allCount, List, Count, %A_LoopField%, %pacsWin%
        selRows := (sel = "") ? 0 : StrSplit(sel, "`n").MaxIndex()
        info .= "  " . A_LoopField . "`n"
        info .= "    Total rows: " . allCount . "`n"
        info .= "    Selected: " . selRows . "`n"
        if (selRows > 0) {
            info .= "    First row: " . SubStr(sel, 1, 200) . "`n"
        } else if (allCount > 0) {
            ; Show first row content even if not selected to verify it's the right list
            ControlGet, firstRow, List, 1, %A_LoopField%, %pacsWin%
            info .= "    Sample row: " . SubStr(firstRow, 1, 200) . "`n"
        }
        info .= "`n"
    }

    info .= "----------------------------------------`n"
    if (listCount = 0)
        info .= "No SysListView32 controls found.`n"
    else
        info .= "Found " . listCount . " SysListView32 control(s).`n"

    Clipboard := info
    MsgBox, 64, PACS Diagnostic, %info%`n`n(Diagnostic copied to clipboard)
return

; ============================================================
;  REMOVE OUTLIERS - flags suspiciously SHORT captures
;  (accidental double-clicks) and missing modality.
;  Does NOT touch long times - long PET/MR are legitimate.
;  Two-pass: (1) per-study-type below mean-2SD, (2) absolute
;  floor under 15s. Shows a review list before deleting.
; ============================================================

MenuRemoveOutliers:
    if !FileExist(LOG_FILE) {
        MsgBox, 48, RadTempo, No log file found.
        return
    }

    FileRead, csvData, %LOG_FILE%
    olLines := StrSplit(csvData, "`n", "`r")
    if (olLines.MaxIndex() < 2) {
        MsgBox, 64, RadTempo, Log file is empty.
        return
    }

    ; --- Pass 1: gather seconds per exam type ---
    examSecs := {}   ; exam -> array of seconds
    Loop, % olLines.MaxIndex() {
        if (A_Index = 1)
            continue
        line := Trim(olLines[A_Index])
        if (line = "")
            continue
        p := StrSplit(line, ",")
        if (p.MaxIndex() < 9)
            continue
        exam := Trim(p[9])
        secs := Trim(p[5]) + 0
        if (exam = "")
            continue
        if (!examSecs.HasKey(exam))
            examSecs[exam] := []
        examSecs[exam].Push(secs)
    }

    ; --- Compute mean/SD per exam type ---
    examMean := {}, examSD := {}
    for exam, arr in examSecs {
        n := arr.MaxIndex()
        if (n < 4)
            continue
        sum := 0
        for i, v in arr
            sum += v
        mean := sum / n
        sumSq := 0
        for i, v in arr
            sumSq += (v - mean) ** 2
        sd := Sqrt(sumSq / (n - 1))
        examMean[exam] := mean
        examSD[exam] := sd
    }

    ; --- Pass 2: flag short outliers + missing modality ---
    ABS_FLOOR := 15   ; seconds - anything below this is almost certainly accidental
    flagged := []     ; array of {idx, line, reason, exam, secs}

    Loop, % olLines.MaxIndex() {
        if (A_Index = 1)
            continue
        line := Trim(olLines[A_Index])
        if (line = "")
            continue
        p := StrSplit(line, ",")
        if (p.MaxIndex() < 7) {
            flagged.Push({idx: A_Index, line: line, reason: "malformed row", exam: "", secs: 0})
            continue
        }
        mod := Trim(p[7])
        exam := (p.MaxIndex() >= 9) ? Trim(p[9]) : ""
        secs := (p.MaxIndex() >= 5) ? Trim(p[5]) + 0 : 0

        reason := ""

        ; Missing modality (and can't derive one)
        if (mod = "") {
            derivedMod := (exam != "") ? ModFromExamText(exam) : ""
            if (derivedMod = "")
                reason := "no modality, can't derive"
        }

        ; Absolute floor - too short to be a real read
        if (reason = "" && secs > 0 && secs < ABS_FLOOR)
            reason := "under " . ABS_FLOOR . "s (accidental)"

        ; Per-type short outlier (below mean - 2SD)
        if (reason = "" && exam != "" && examMean.HasKey(exam)) {
            floor := examMean[exam] - 2 * examSD[exam]
            if (secs < floor && secs < examMean[exam] / 2)
                reason := "short for type (avg " . Round(examMean[exam]) . "s)"
        }

        if (reason != "")
            flagged.Push({idx: A_Index, line: line, reason: reason, exam: exam, secs: secs})
    }

    if (flagged.MaxIndex() = 0 || flagged.MaxIndex() = "") {
        MsgBox, 64, Remove Outliers, No outliers found.`n`nNo suspiciously short captures or missing-modality rows detected.
        return
    }

    ; --- Build review list ---
    reviewText := ""
    for i, item in flagged {
        examShort := (StrLen(item.exam) > 40) ? SubStr(item.exam, 1, 40) . ".." : item.exam
        if (examShort = "")
            examShort := "(no exam text)"
        reviewText .= item.secs . "s  |  " . examShort . "  |  " . item.reason . "`n"
    }

    nFlagged := flagged.MaxIndex()
    msgBody := "Found " . nFlagged . " suspicious entries (short captures or missing modality).`n`n"
    msgBody .= "Long studies are NOT flagged - long PET/MR reads are kept.`n`n"
    msgBody .= SubStr(reviewText, 1, 2500)
    msgBody .= "`n`nDelete these " . nFlagged . " entries?"
    MsgBox, 52, Remove Outliers - Review, %msgBody%
    IfMsgBox No
        return

    ; --- Build set of indices to delete ---
    delIdx := {}
    for i, item in flagged
        delIdx[item.idx] := true

    ; --- Rewrite the file without flagged rows ---
    newContent := olLines[1] . "`n"  ; header
    kept := 0
    Loop, % olLines.MaxIndex() {
        if (A_Index = 1)
            continue
        if (delIdx.HasKey(A_Index))
            continue
        line := Trim(olLines[A_Index])
        if (line = "")
            continue
        newContent .= line . "`n"
        kept++
    }

    ; Backup first
    backupFile := LOG_FILE . ".bak"
    FileCopy, %LOG_FILE%, %backupFile%, 1

    fh := FileOpen(LOG_FILE, "w", "UTF-8-RAW")
    if (fh) {
        fh.Write(newContent)
        fh.Close()
    }

    ; Reload today's counts
    InitTodayCount()
    LoadExamAverages()
    LoadShiftStats()
    GuiControl, Main:, CountDisplay, %todayCount%
    ivuR := Format("{:.1f}", todayIVU)
    GuiControl, Main:, IVUDisplay, %ivuR%

    doneMsg := "Removed " . nFlagged . " outlier entries.`n" . kept . " studies remain.`n`nA backup was saved to:`n" . backupFile
    MsgBox, 64, Remove Outliers, %doneMsg%
return

MenuCleanDB:
    if !FileExist(LOG_FILE) {
        MsgBox, 48, RadTempo, No log file found.
        return
    }

    FileRead, csvData, %LOG_FILE%
    lines := StrSplit(csvData, "`n", "`r")

    if (lines.MaxIndex() < 2) {
        MsgBox, 64, RadTempo, Log file is empty.
        return
    }

    fixed := 0
    removed := 0
    cleaned := []
    ; Keep header
    cleaned.Push(lines[1])

    Loop, % lines.MaxIndex() {
        if (A_Index = 1)
            continue
        line := Trim(lines[A_Index])
        if (line = "")
            continue

        parts := StrSplit(line, ",")

        ; Skip rows with fewer than 7 columns (malformed)
        if (parts.MaxIndex() < 7) {
            removed++
            continue
        }

        ; Fix empty modality
        mod := Trim(parts[7])
        exam := (parts.MaxIndex() >= 9) ? Trim(parts[9]) : ""
        ivu := (parts.MaxIndex() >= 10) ? Trim(parts[10]) : ""

        ; Auto-correct modality from exam text if empty or wrong
        if (exam != "") {
            correctMod := ModFromExamText(exam)
            if (correctMod != "" && correctMod != mod) {
                parts[7] := correctMod
                fixed++
            }
        }

        ; Fix IVU - re-lookup if 0 or empty but exam text exists
        if (exam != "" && (ivu = "" || ivu = "0" || ivu = "0.00")) {
            newIVU := IVU_Lookup(exam)
            if (newIVU > 0) {
                ivuStr := Format("{:.2f}", newIVU)
                ; Ensure parts array is long enough
                while (parts.MaxIndex() < 10)
                    parts.Push("")
                parts[10] := ivuStr
                fixed++
            }
        }

        ; Fix IVU values without decimals (e.g. 125 instead of 1.25)
        if (ivu != "") {
            ivuNum := ivu + 0.0
            if (ivuNum > 10) {
                ivuNum := ivuNum / 100
                while (parts.MaxIndex() < 10)
                    parts.Push("")
                parts[10] := Format("{:.2f}", ivuNum)
                fixed++
            }
        }

        ; Strip trailing dates from exam text
        if (exam != "") {
            examClean := RegExReplace(exam, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
            examClean := Trim(examClean)
            if (examClean != exam && parts.MaxIndex() >= 9) {
                parts[9] := examClean
                fixed++
            }
        }

        ; Normalize extra whitespace in exam text
        if (parts.MaxIndex() >= 9) {
            parts[9] := RegExReplace(parts[9], "\s+", " ")
            parts[9] := Trim(parts[9])
        }

        ; Rebuild line
        newLine := ""
        Loop, % parts.MaxIndex() {
            if (A_Index > 1)
                newLine .= ","
            newLine .= parts[A_Index]
        }
        cleaned.Push(newLine)
    }

    ; Write cleaned file
    FileDelete, %LOG_FILE%
    for i, line in cleaned {
        FileAppend, %line%`n, %LOG_FILE%
    }

    ; Reload today's counts
    InitTodayCount()
    LoadExamAverages()
    LoadShiftStats()
    GuiControl, Main:, CountDisplay, %todayCount%
    ivuRound := Format("{:.1f}", todayIVU)
    GuiControl, Main:, IVUDisplay, %ivuRound%

    totalRows := cleaned.MaxIndex() - 1
    MsgBox, 64, Database Cleaned, % "Processed " . totalRows . " studies.`n`nFixed: " . fixed . " fields`nRemoved: " . removed . " malformed rows"
return

MenuWellness60:
    SetWellnessInterval(60)
return

MenuWellness90:
    SetWellnessInterval(90)
return

MenuWellnessReset:
    CreditBreak()
    NotifyAtWidget("Strain reset. Next nudge after " . (STREAK_LIMIT // 60000) . " min at the desk.")
return

; ============================================================
;  SPEED WARNING menu handlers
; ============================================================

MenuSpeedOn:
    warnEnabled := true
    Menu, SpeedMenu, Check, Turn On
    Menu, SpeedMenu, Uncheck, Turn Off
    SaveSetting("WarnEnabled", 1)
return

MenuSpeedOff:
    warnEnabled := false
    Menu, SpeedMenu, Check, Turn Off
    Menu, SpeedMenu, Uncheck, Turn On
    SaveSetting("WarnEnabled", 0)
    ; Clear any active warning immediately
    ClearWarning()
    if (timerRunning) {
        Gui, Main:Color, %BG_RUN%
        Gui, AccentBar:Color, %ACCENT_RUN%
        GuiControl, Main:+c%TXT_RUN%, TimeDisplay
        GuiControl, Main:, StatusLabel, DICTATING
        GuiControl, Main:+c%ACCENT_RUN%, StatusLabel
    }
return

MenuSpeed125:
    WARN_PCT := 125
    warnThreshold := 0
    SaveSetting("WarnPct", 125)
    Menu, SpeedMenu, Check, Warn at 125`%
    Menu, SpeedMenu, Uncheck, Warn at 150`%
    Menu, SpeedMenu, Uncheck, Warn at 200`%
return

; --- Activity tracking handlers ---
MenuActOn:
    ACT_ENABLED := true
    SaveSetting("ActivityEnabled", 1)
    Menu, ActMenu, Check, Turn On
    Menu, ActMenu, Uncheck, Turn Off
return

MenuActOff:
    ACT_ENABLED := false
    SaveSetting("ActivityEnabled", 0)
    Menu, ActMenu, Check, Turn Off
    Menu, ActMenu, Uncheck, Turn On
    RestoreAccentWidth()
return

MenuAct30:
    SetAwayThreshold(30)
return

MenuAct60:
    SetAwayThreshold(60)
return

MenuAct90:
    SetAwayThreshold(90)
return

; Shared by the three threshold menu items
SetAwayThreshold(sec) {
    global ACT_IDLE_MS
    ACT_IDLE_MS := sec * 1000
    SaveSetting("ActivityIdleSec", sec)
    Menu, ActMenu, Uncheck, Away after 30s
    Menu, ActMenu, Uncheck, Away after 60s
    Menu, ActMenu, Uncheck, Away after 90s
    Menu, ActMenu, Check, % "Away after " . sec . "s"
}

MenuGoalSet:
    FormatTime, gDate,, M/d/yyyy
    typ := TypicalDailyIVU()
    ; Seed with the rung still in play. Finishing between two rungs pays the
    ; same as the rung below, so a goal that isn't ON one is worth nothing
    ; extra - and once today's goal is met the box opens on the NEXT rung
    ; rather than on the number you already beat.
    gBase := (todayIVU > todayGoal) ? todayIVU : todayGoal
    if (gBase = 0)
        gBase := typ
    cur := (todayGoal > 0 && todayIVU < todayGoal) ? todayGoal : NextRung(gBase)
    cur := Round(cur * 10) / 10
    GetWidgetMonitorPos(340, 210, gx, gy)
    InputBox, gVal, Daily IVU Goal, % "IVU target for today (" . gDate . ").`n`nA typical day for you is about " . Format("{:.1f}", typ) . " IVU.`nRungs: " . RungList(gBase) . "`nEnter 0 to clear.", , 340, 210, %gx%, %gy%, , , %cur%
    if (ErrorLevel)
        return
    SaveGoal(gDate, (gVal + 0 > 0) ? gVal + 0 : 0)
    if (gVal + 0 > 0)
        NotifyAtWidget("Goal today: " . GoalBlurb(gVal + 0))
    else
        NotifyAtWidget("Today's goal cleared")
return

MenuGoalTypical:
    FormatTime, gDate,, M/d/yyyy
    SaveGoal(gDate, Round(TypicalDailyIVU() * 10) / 10)
    NotifyAtWidget("Goal today: " . GoalBlurb(todayGoal) . "   (a typical day)")
return

; One handler for every rung preset - the value is read back out of the item
; text, so the list stays driven by GOAL_BASE / GOAL_STEP with nothing to keep
; in sync.
MenuGoalRung:
    FormatTime, gDate,, M/d/yyyy
    rungPick := RegExReplace(A_ThisMenuItem, "^\s*(\d+(?:\.\d+)?).*$", "$1") + 0
    if (rungPick > 0) {
        SaveGoal(gDate, rungPick)
        NotifyAtWidget("Goal today: " . GoalBlurb(rungPick))
    }
return

MenuGoalClear:
    FormatTime, gDate,, M/d/yyyy
    SaveGoal(gDate, 0)
    NotifyAtWidget("Today's goal cleared")
return

; Rebuild pars from the log. Par normally refreshes after each sign; this is
; for after a Clean Database / Remove Outliers, or to pick up newly-logged
; engaged-time samples in bulk.
MenuParRecompute:
    LoadExamAverages()
    parCount := 0
    for parKey, parVal in examParMap
        parCount++
    MsgBox, 64, Par, % "Pars recomputed from history.`n`nExam types with their own par: " . parCount . "`nEverything else falls back to the modality median."
return

MenuSpeed150:
    WARN_PCT := 150
    warnThreshold := 0
    SaveSetting("WarnPct", 150)
    Menu, SpeedMenu, Check, Warn at 150`%
    Menu, SpeedMenu, Uncheck, Warn at 125`%
    Menu, SpeedMenu, Uncheck, Warn at 200`%
return

MenuSpeed200:
    WARN_PCT := 200
    warnThreshold := 0
    SaveSetting("WarnPct", 200)
    Menu, SpeedMenu, Check, Warn at 200`%
    Menu, SpeedMenu, Uncheck, Warn at 125`%
    Menu, SpeedMenu, Uncheck, Warn at 150`%
return

; ============================================================
;  FIX LAST - change modality on most recent log entry
; ============================================================

FixLastCR:
    FixLastModality("CR")
return
FixLastCT:
    FixLastModality("CT")
return
FixLastMR:
    FixLastModality("MR")
return
FixLastUS:
    FixLastModality("US")
return
FixLastPET:
    FixLastModality("PET")
return

FixLastModality(newMod) {
    global LOG_FILE
    if !FileExist(LOG_FILE) {
        ToolTip, No log data to fix, 0, 0
        SetTimer, ClearToolTip, -2000
        return
    }

    FileRead, csvData, %LOG_FILE%
    lines := StrSplit(csvData, "`n", "`r")

    ; Find last non-empty line
    lastIdx := 0
    for i, line in lines {
        if (line != "")
            lastIdx := i
    }
    if (lastIdx < 2) {
        ToolTip, No entries to fix, 0, 0
        SetTimer, ClearToolTip, -2000
        return
    }

    ; Parse last line and replace modality field (column 7)
    fields := StrSplit(lines[lastIdx], ",")
    oldMod := fields[7]
    fields[7] := newMod

    ; Rebuild the line
    newLine := ""
    for i, f in fields {
        if (i > 1)
            newLine .= ","
        newLine .= f
    }
    lines[lastIdx] := newLine

    ; Rebuild full file
    output := ""
    for i, line in lines {
        if (line != "")
            output .= line . "`n"
    }

    FileDelete, %LOG_FILE%
    FileAppend, %output%, %LOG_FILE%

    ToolTip, % "Fixed: " . oldMod . " -> " . newMod, 0, 0
    SetTimer, ClearToolTip, -2000
}

MenuRewardToday:
    rPts := RewardTodayPoints()
    rRung := GoalCredits(todayIVU)
    rMsg := "Today: " . Format("{:.0f}", rPts) . " pts  =  $" . Format("{:.2f}", RewardDollars(rPts))
    rMsg .= "`n" . parWinsToday . " of " . parRunToday . " under par"
    if (parBestToday >= REWARD_STREAK_EVERY)
        rMsg .= "  (best run " . parBestToday . ")"
    rMsg .= "`n" . (rRung > 0 ? ("rung " . rRung . " cleared") : "no rung yet")
          . " at " . Format("{:.1f}", todayIVU) . " IVU"
    NotifyAtWidget(rMsg)
return

MenuRewardBank:
    rEarned := RewardEarnedTotal()
    rBal := rEarned - rewardCashed
    if (rBal < 0)
        rBal := 0
    bMsg := "Bank: $" . Format("{:.2f}", rBal)
    bMsg .= "`n$" . Format("{:.2f}", rEarned) . " earned, $" . Format("{:.2f}", rewardCashed) . " taken out"
    bMsg .= "`nToday so far: $" . Format("{:.2f}", RewardDollars(RewardTodayPoints()))
    NotifyAtWidget(bMsg)
return

MenuRewardCashOut:
    ; No stored card, no automatic spending. This records the withdrawal, puts
    ; the amount on the clipboard and offers to open the gift-card page - the
    ; purchase itself stays a deliberate act.
    coBal := RewardBalance()
    if (coBal < 1) {
        NotifyAtWidget("Bank is at $" . Format("{:.2f}", coBal) . " - nothing to take out yet.")
        return
    }
    GetWidgetMonitorPos(360, 210, cox, coy)
    coDef := Format("{:.2f}", Floor(coBal))
    InputBox, coAmt, Cash Out, % "Bank balance: $" . Format("{:.2f}", coBal) . "`n`nHow much are you taking out?`nThis records the withdrawal and copies the amount.`nBuying the card stays a manual step.", , 360, 210, %cox%, %coy%, , , %coDef%
    if (ErrorLevel)
        return
    coAmt := coAmt + 0.0
    if (coAmt <= 0)
        return
    if (coAmt > coBal) {
        NotifyAtWidget("That is more than the bank holds ($" . Format("{:.2f}", coBal) . ").")
        return
    }
    AppendCashOut(coAmt, "gift card")
    Clipboard := Format("{:.2f}", coAmt)
    NotifyAtWidget("$" . Format("{:.2f}", coAmt) . " taken out. Amount copied."
                 . "`nBank now $" . Format("{:.2f}", RewardBalance()) . ".")
    MsgBox, 36, Cash Out, % "Recorded $" . Format("{:.2f}", coAmt) . " and copied it to the clipboard.`n`nOpen " . REWARD_STORE_URL . " now?"
    IfMsgBox Yes
        Run, %REWARD_STORE_URL%
return

MenuRewardRate:
    GetWidgetMonitorPos(360, 200, rrx, rry)
    rrDef := Format("{:.2f}", REWARD_PER_POINT)
    InputBox, rrVal, Reward Rate, % "Dollars per point.`n`nAt " . rrDef . ", a solid day (25 wins, rung 2) pays about $" . Format("{:.2f}", RewardDollars(RewardPoints(25, 30, 10, 2))) . ".`nWeekly cap is $" . REWARD_WEEK_CAP . ".", , 360, 200, %rrx%, %rry%, , , %rrDef%
    if (ErrorLevel)
        return
    if (rrVal + 0 >= 0) {
        REWARD_PER_POINT := rrVal + 0.0
        SaveSetting("RewardPerPoint", REWARD_PER_POINT)
        NotifyAtWidget("$" . Format("{:.2f}", REWARD_PER_POINT) . " per point."
                     . "`nToday is worth $" . Format("{:.2f}", RewardDollars(RewardTodayPoints())) . " so far.")
    }
return

MenuRewardRestart:
    MsgBox, 36, Start the Bank Today, % "Zero the bank and count only from today?`n`nEverything logged before today stops counting toward earnings.`nCash-outs already recorded are kept."
    IfMsgBox Yes
    {
        FormatTime, REWARD_START,, yyyyMMdd
        SaveSetting("RewardStartDate", REWARD_START)
        NotifyAtWidget("Bank starts today.`nEarned so far: $" . Format("{:.2f}", RewardEarnedTotal()) . ".")
    }
return

MenuRefetchExam:
    ForceRefetchExam()
return

MenuSetExamTitle:
    SetExamTitleManually()
return

; ============================================================
;  UNDO LAST - remove most recent log entry entirely
; ============================================================

MenuUndoLast:
    if !FileExist(LOG_FILE) {
        ToolTip, No log data to undo, 0, 0
        SetTimer, ClearToolTip, -2000
        return
    }

    FileRead, csvData, %LOG_FILE%
    lines := StrSplit(csvData, "`n", "`r")

    ; Find last non-empty line
    lastIdx := 0
    for i, line in lines {
        if (line != "")
            lastIdx := i
    }
    if (lastIdx < 2) {
        ToolTip, No entries to undo, 0, 0
        SetTimer, ClearToolTip, -2000
        return
    }

    ; Grab info for tooltip before removing
    fields := StrSplit(lines[lastIdx], ",")
    removedMod := fields[7]
    removedTime := fields[6]
    removedIVU := (fields.MaxIndex() >= 10) ? fields[10] + 0.0 : 0.0

    ; Remove last line
    lines.RemoveAt(lastIdx)

    ; Rebuild file
    output := ""
    for i, line in lines {
        if (line != "")
            output .= line . "`n"
    }

    FileDelete, %LOG_FILE%
    FileAppend, %output%, %LOG_FILE%

    ; Decrement counters
    if (todayCount > 0)
        todayCount--
    todayIVU -= removedIVU
    if (todayIVU < 0)
        todayIVU := 0.0
    if (removedMod = "CR")
        todayIVU_CR -= removedIVU
    else if (removedMod = "CT")
        todayIVU_CT -= removedIVU
    else if (removedMod = "MR")
        todayIVU_MR -= removedIVU
    else if (removedMod = "US")
        todayIVU_US -= removedIVU
    else if (removedMod = "PET")
        todayIVU_PET -= removedIVU
    GuiControl, Main:, CountDisplay, %todayCount%
    ivuRound := Format("{:.1f}", todayIVU)
    GuiControl, Main:, IVUDisplay, %ivuRound%

    ToolTip, % "Undone: " . removedMod . " " . removedTime, 0, 0
    SetTimer, ClearToolTip, -2000
return

MenuExit:
MainGuiClose:
    WinGetPos, exX, exY,,, ahk_id %MainHwnd%
    if (exX != "" && exY != "") {
        IniWrite, %exX%, %INI_FILE%, Window, PosX
        IniWrite, %exY%, %INI_FILE%, Window, PosY
    }
ExitApp
