import AppKit
import CoreImage.CIFilterBuiltins
import Darwin
import Foundation
import SystemConfiguration

private let appLanguage: String = {
    let code = Locale.preferredLanguages.first?.lowercased().split(separator: "-").first.map(String.init) ?? "en"
    return ["ja", "en", "zh", "ko", "es", "fr", "de"].contains(code) ? code : "en"
}()
private let appTranslations: [String: [String: String]] = [
    "zh": [
        "Connect iPhone": "连接 iPhone",
        "Send Files to iPhone": "发送文件到 iPhone",
        "Connection & Settings": "连接与设置",
        "iPhone: Disconnected": "iPhone：未连接",
        "Transfer Setup": "传输设置",
        "Unpair": "取消配对",
        "Upgrade to PRO": "升级到 PRO",
        "Received File Location": "接收文件保存位置",
        "About iPhone Data Sharing": "关于 iPhone Data Sharing",
        "Quit iPhone Data Sharing": "退出 iPhone Data Sharing",
        "iPhone: Checking…": "iPhone：检查中…",
        "iPhone: Connected": "iPhone：已连接",
        "PRO License": "PRO 许可证",
        "Choose where files received from iPhone should be saved": "选择从 iPhone 接收文件的保存位置",
        "Choose": "选择",
        "Could not change the save location. Check the folder permissions.": "无法更改保存位置，请检查文件夹权限。",
        "Start Pairing": "开始配对",
        "Scan this with the iPhone camera within 5 minutes to pair.": "请在 5 分钟内用 iPhone 相机扫描以配对。",
        "Could not unpair the device.": "无法取消配对。",
        "Could not generate the QR code.": "无法生成二维码。",
        "Scan with your iPhone camera": "请用 iPhone 相机扫描",
    ],
    "ko": [
        "Connect iPhone": "iPhone 연결",
        "Send Files to iPhone": "iPhone으로 파일 보내기",
        "Connection & Settings": "연결 및 설정",
        "iPhone: Disconnected": "iPhone: 연결 안 됨",
        "Transfer Setup": "전송 설정",
        "Unpair": "페어링 해제",
        "Upgrade to PRO": "PRO로 업그레이드",
        "Received File Location": "수신 파일 저장 위치",
        "About iPhone Data Sharing": "iPhone Data Sharing 정보",
        "Quit iPhone Data Sharing": "iPhone Data Sharing 종료",
        "iPhone: Checking…": "iPhone: 확인 중…",
        "iPhone: Connected": "iPhone: 연결됨",
        "PRO License": "PRO 라이선스",
        "Choose where files received from iPhone should be saved": "iPhone에서 받은 파일의 저장 위치를 선택하세요",
        "Choose": "선택",
        "Could not change the save location. Check the folder permissions.": "저장 위치를 변경할 수 없습니다. 폴더 권한을 확인하세요.",
        "Start Pairing": "페어링 시작",
        "Scan this with the iPhone camera within 5 minutes to pair.": "5분 이내에 iPhone 카메라로 스캔해 페어링하세요.",
        "Could not unpair the device.": "페어링을 해제할 수 없습니다.",
        "Could not generate the QR code.": "QR 코드를 생성할 수 없습니다.",
        "Scan with your iPhone camera": "iPhone 카메라로 스캔하세요",
    ],
    "es": [
        "Connect iPhone": "Conectar iPhone",
        "Send Files to iPhone": "Enviar archivos al iPhone",
        "Connection & Settings": "Conexión y ajustes",
        "iPhone: Disconnected": "iPhone: desconectado",
        "Transfer Setup": "Configuración de transferencia",
        "Unpair": "Desenlazar",
        "Upgrade to PRO": "Actualizar a PRO",
        "Received File Location": "Ubicación de archivos recibidos",
        "About iPhone Data Sharing": "Acerca de iPhone Data Sharing",
        "Quit iPhone Data Sharing": "Salir de iPhone Data Sharing",
        "iPhone: Checking…": "iPhone: comprobando…",
        "iPhone: Connected": "iPhone: conectado",
        "PRO License": "Licencia PRO",
        "Choose where files received from iPhone should be saved": "Elige dónde guardar los archivos recibidos del iPhone",
        "Choose": "Elegir",
        "Could not change the save location. Check the folder permissions.": "No se pudo cambiar la ubicación. Comprueba los permisos de la carpeta.",
        "Start Pairing": "Iniciar enlace",
        "Scan this with the iPhone camera within 5 minutes to pair.": "Escanéalo con la cámara del iPhone en 5 minutos para enlazar.",
        "Could not unpair the device.": "No se pudo desenlazar el dispositivo.",
        "Could not generate the QR code.": "No se pudo generar el QR.",
        "Scan with your iPhone camera": "Escanea con la cámara del iPhone",
    ],
    "fr": [
        "Connect iPhone": "Connecter l’iPhone",
        "Send Files to iPhone": "Envoyer des fichiers à l’iPhone",
        "Connection & Settings": "Connexion et réglages",
        "iPhone: Disconnected": "iPhone : déconnecté",
        "Transfer Setup": "Configuration du transfert",
        "Unpair": "Dissocier",
        "Upgrade to PRO": "Passer à PRO",
        "Received File Location": "Emplacement des fichiers reçus",
        "About iPhone Data Sharing": "À propos de iPhone Data Sharing",
        "Quit iPhone Data Sharing": "Quitter iPhone Data Sharing",
        "iPhone: Checking…": "iPhone : vérification…",
        "iPhone: Connected": "iPhone : connecté",
        "PRO License": "Licence PRO",
        "Choose where files received from iPhone should be saved": "Choisissez où enregistrer les fichiers reçus de l’iPhone",
        "Choose": "Choisir",
        "Could not change the save location. Check the folder permissions.": "Impossible de changer l’emplacement. Vérifiez les autorisations du dossier.",
        "Start Pairing": "Démarrer l’association",
        "Scan this with the iPhone camera within 5 minutes to pair.": "Scannez avec l’appareil photo de l’iPhone dans les 5 minutes pour associer.",
        "Could not unpair the device.": "Impossible de dissocier l’appareil.",
        "Could not generate the QR code.": "Impossible de générer le QR.",
        "Scan with your iPhone camera": "Scannez avec l’appareil photo de l’iPhone",
    ],
    "de": [
        "Connect iPhone": "iPhone verbinden",
        "Send Files to iPhone": "Dateien an iPhone senden",
        "Connection & Settings": "Verbindung & Einstellungen",
        "iPhone: Disconnected": "iPhone: getrennt",
        "Transfer Setup": "Übertragung einrichten",
        "Unpair": "Kopplung aufheben",
        "Upgrade to PRO": "Auf PRO upgraden",
        "Received File Location": "Speicherort empfangener Dateien",
        "About iPhone Data Sharing": "Über iPhone Data Sharing",
        "Quit iPhone Data Sharing": "iPhone Data Sharing beenden",
        "iPhone: Checking…": "iPhone: wird geprüft…",
        "iPhone: Connected": "iPhone: verbunden",
        "PRO License": "PRO-Lizenz",
        "Choose where files received from iPhone should be saved": "Wähle den Speicherort für vom iPhone empfangene Dateien",
        "Choose": "Auswählen",
        "Could not change the save location. Check the folder permissions.": "Speicherort konnte nicht geändert werden. Prüfe die Ordnerrechte.",
        "Start Pairing": "Kopplung starten",
        "Scan this with the iPhone camera within 5 minutes to pair.": "Scanne dies innerhalb von 5 Minuten mit der iPhone-Kamera.",
        "Could not unpair the device.": "Kopplung konnte nicht aufgehoben werden.",
        "Could not generate the QR code.": "QR-Code konnte nicht erzeugt werden.",
        "Scan with your iPhone camera": "Mit der iPhone-Kamera scannen",
    ],
]
private func tr(_ ja: String, _ en: String) -> String {
    if appLanguage == "ja" { return ja }
    if appLanguage == "en" { return en }
    return appTranslations[appLanguage]?[en] ?? en
}
private var usesJapaneseUI: Bool { appLanguage == "ja" }

private struct PairingResponse: Decodable {
    let url: String
}

private struct PairingState: Decodable {
    let paired: Bool
    let receivedCount: Int
}

private struct DownloadDirectory: Codable {
    let directory: String
}

private struct LicenseSummary: Decodable {
    let plan: String
}
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private var port = 3000
    private var statusItem: NSStatusItem!
    private var agent: Process?
    private var pairingWindow: NSWindow?
    private var connectItem: NSMenuItem!
    private var sendItem: NSMenuItem!
    private var connectionStatus: NSMenuItem!
    private var unpairItem: NSMenuItem!
    private var proItem: NSMenuItem!
    private var paired = false
    private var isPro = false
    private var checkingLicenseState = false
    private var lastReceivedCount: Int?
    private var didLoadPairingState = false
    private var checkingPairingState = false
    private let connectionMonitorStartedAt = Date()
    private var lastSuccessfulCheck: Date?
    private var agentStartupPending = false
    private var logHandle: FileHandle?

    private var localURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menuIcon = NSImage(named: "MenuIcon") ?? NSImage(systemSymbolName: "paperplane", accessibilityDescription: "iPhone Data Sharing")
        menuIcon?.size = NSSize(width: 18, height: 18)
        menuIcon?.isTemplate = true
        statusItem.button?.image = menuIcon
        statusItem.button?.imageScaling = .scaleProportionallyDown
        if statusItem.button?.image == nil { statusItem.button?.title = "⇄" }

        let menu = NSMenu()
        connectItem = NSMenuItem(title: tr("iPhoneを接続", "Connect iPhone"), action: #selector(showPairing), keyEquivalent: "")
        connectItem.target = self
        menu.addItem(connectItem)
        sendItem = NSMenuItem(title: tr("iPhoneにファイルを送る", "Send Files to iPhone"), action: #selector(openTransfer), keyEquivalent: "")
        sendItem.target = self
        menu.addItem(sendItem)
        menu.addItem(.separator())
        let connections = NSMenuItem(title: tr("接続・設定", "Connection & Settings"), action: nil, keyEquivalent: "")
        let connectionMenu = NSMenu()
        connectionStatus = NSMenuItem(title: tr("iPhone：未接続", "iPhone: Disconnected"), action: nil, keyEquivalent: "")
        connectionStatus.isEnabled = false
        connectionMenu.addItem(connectionStatus)
        let setup = NSMenuItem(title: tr("送受信設定情報", "Transfer Setup"), action: #selector(showShareSetup), keyEquivalent: "")
        setup.target = self
        connectionMenu.addItem(setup)
        unpairItem = NSMenuItem(title: tr("ペアリングを解除", "Unpair"), action: #selector(unpair), keyEquivalent: "")
        unpairItem.target = self
        connectionMenu.addItem(unpairItem)
        connectionMenu.addItem(.separator())
        proItem = NSMenuItem(title: tr("PRO版にアップデートする", "Upgrade to PRO"), action: #selector(showDetails), keyEquivalent: "")
        proItem.target = self
        connectionMenu.addItem(proItem)
        connections.submenu = connectionMenu
        menu.addItem(connections)
        let destination = NSMenuItem(title: tr("受信ファイルの保存先", "Received File Location"), action: #selector(chooseDownloadDirectory), keyEquivalent: "")
        destination.target = self
        menu.addItem(destination)
        menu.addItem(.separator())
        let about = NSMenuItem(title: tr("iPhone Data Sharingについて", "About iPhone Data Sharing"), action: #selector(showAbout), keyEquivalent: "")
        about.target = self
        menu.addItem(about)
        let quit = NSMenuItem(title: tr("iPhone Data Sharingを終了", "Quit iPhone Data Sharing"), action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
        menu.delegate = self
        updateConnectionMenu()
        removeLegacyFinderQuickAction()

        launchAgentWhenPortIsFree()
        let refresh = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.refreshPairingState() }
        RunLoop.main.add(refresh, forMode: .common)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func menuWillOpen(_ menu: NSMenu) {
        updateConnectionMenu()
        refreshPairingState()
        refreshLicenseState()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    private func launchAgentWhenPortIsFree(attempt: Int = 0) {
        if isPortAvailable(3000) {
            agentStartupPending = false
            if startAgent() { whenReady { [weak self] in self?.refreshPairingState() } }
        } else if attempt < 20 {
            agentStartupPending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.launchAgentWhenPortIsFree(attempt: attempt + 1)
            }
        } else {
            agentStartupPending = false
            showError(tr("ポート3000が使用中です。ほかのiPhone Data Sharingを終了してメニューから再試行してください。", "Port 3000 is in use. Quit other iPhone Data Sharing instances and try again from the menu."))
        }
    }

    @discardableResult private func startAgent() -> Bool {
        guard let resources = Bundle.main.resourceURL,
              let executable = Bundle.main.executableURL else { showError(tr("アプリの構成を読み取れませんでした。", "The app configuration could not be read.")) ; return false }
        let script = resources.appendingPathComponent("server/dist/local-agent.js")
        let node = executable.deletingLastPathComponent().appendingPathComponent("node")
        guard FileManager.default.fileExists(atPath: script.path), FileManager.default.fileExists(atPath: node.path) else {
            showError(tr("Agent の実行ファイルが見つかりません。アプリを再ビルドしてください。", "The Agent executable could not be found. Rebuild the app."))
            return false
        }
        guard isPortAvailable(3000) else {
            showError(tr("ポート3000をほかのアプリが使用中です。使用中のアプリを終了して iPhone Data Sharing を開き直してください。", "Another app is using port 3000. Quit that app and reopen iPhone Data Sharing."))
            return false
        }
        port = 3000

        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        process.currentDirectoryURL = resources.appendingPathComponent("server")
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["AGENT_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment.removeValue(forKey: "AGENT_PARENT_PIPE")
        if let localName = SCDynamicStoreCopyLocalHostName(nil) as String? {
            environment["PUBLIC_BASE_URL"] = "http://\(localName).local:3000"
        }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice

        let logDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let logURL = logDirectory.appendingPathComponent("iPhone Data Sharing Agent.log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        logHandle = try? FileHandle(forWritingTo: logURL)
        _ = try? logHandle?.seekToEnd()
        process.standardOutput = logHandle ?? FileHandle.nullDevice
        process.standardError = logHandle ?? FileHandle.nullDevice

        do {
            try process.run()
            agent = process
            process.terminationHandler = { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self, self.agent === finished else { return }
                    self.agent = nil
                    self.lastSuccessfulCheck = nil
                    self.updateConnectionMenu()
                    self.showError("Agent が終了しました（終了コード: \(finished.terminationStatus)）。再起動はメニューから操作を選んでください。ログ: \(logURL.path)")
                }
            }
            return true
        } catch {
            showError("Agent を起動できませんでした: \(error.localizedDescription)")
            return false
        }
    }

    private func isPortAvailable(_ candidate: Int) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(candidate).bigEndian)
        address.sin_addr = in_addr(s_addr: INADDR_ANY)
        return withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    private func whenReady(_ work: @escaping () -> Void, attempt: Int = 0) {
        if agentStartupPending {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.whenReady(work, attempt: attempt) }
            return
        }
        if agent?.isRunning != true && !startAgent() { return }
        var request = URLRequest(url: localURL.appendingPathComponent("health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                if (response as? HTTPURLResponse)?.statusCode == 200 { work() }
                else if attempt < 20 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self?.whenReady(work, attempt: attempt + 1) }
                } else { self?.showError(tr("Agent に接続できません。iPhone Data Sharing Agent.log を確認してください。", "Could not connect to the Agent. Check iPhone Data Sharing Agent.log.")) }
            }
        }.resume()
    }

    @objc private func openTransfer() {
        whenReady { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(self.localURL.appendingPathComponent("transfer"))
        }
    }

    @objc private func chooseDownloadDirectory() {
        whenReady { [weak self] in
            guard let self else { return }
            URLSession.shared.dataTask(with: self.localURL.appendingPathComponent("admin/download-directory")) { [weak self] data, _, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    let current = data.flatMap { try? JSONDecoder().decode(DownloadDirectory.self, from: $0) }
                    let panel = NSOpenPanel()
                    panel.message = tr("iPhoneから受け取ったファイルの保存先を選択してください", "Choose where files received from iPhone should be saved")
                    panel.prompt = tr("選択", "Choose")
                    panel.canChooseFiles = false
                    panel.canChooseDirectories = true
                    panel.allowsMultipleSelection = false
                    if let current { panel.directoryURL = URL(fileURLWithPath: current.directory, isDirectory: true) }
                    guard panel.runModal() == .OK, let selected = panel.url else { return }
                    var request = URLRequest(url: self.localURL.appendingPathComponent("admin/download-directory"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = try? JSONEncoder().encode(DownloadDirectory(directory: selected.path))
                    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
                        DispatchQueue.main.async {
                            if (response as? HTTPURLResponse)?.statusCode != 200 { self?.showError(tr("保存先を変更できませんでした。フォルダのアクセス権を確認してください。", "Could not change the save location. Check the folder permissions.")) }
                        }
                    }.resume()
                }
            }.resume()
        }
    }

    private func refreshPairingState() {
        updateConnectionMenu()
        guard agent?.isRunning == true, !checkingPairingState else { return }
        checkingPairingState = true
        var request = URLRequest(url: localURL.appendingPathComponent("admin/pairing-state"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.checkingPairingState = false
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let data, let state = try? JSONDecoder().decode(PairingState.self, from: data) else {
                    self.updateConnectionMenu()
                    return
                }
                self.lastSuccessfulCheck = Date()
                let wasPaired = self.paired
                self.paired = state.paired
                self.updateConnectionMenu()
                if let previous = self.lastReceivedCount, state.receivedCount > previous {
                    NSSound(named: NSSound.Name("Glass"))?.play()
                }
                self.lastReceivedCount = state.receivedCount
                if !self.didLoadPairingState {
                    self.didLoadPairingState = true
                    if !state.paired { self.showPairing() }
                } else if !wasPaired && state.paired && self.pairingWindow?.title == tr("ペアリング開始", "Start Pairing") {
                    self.pairingWindow?.orderOut(nil)
                }
            }
        }.resume()
    }
    private func updateConnectionMenu() {
        connectItem.isHidden = paired
        sendItem.isHidden = !paired
        let age = Date().timeIntervalSince(lastSuccessfulCheck ?? connectionMonitorStartedAt)
        if didLoadPairingState && agent?.isRunning != true {
            connectionStatus.title = tr("iPhone：未接続", "iPhone: Disconnected")
        } else if age > 10 {
            connectionStatus.title = tr("iPhone：未接続", "iPhone: Disconnected")
        } else if age > 3 || lastSuccessfulCheck == nil {
            connectionStatus.title = tr("iPhone：確認中…", "iPhone: Checking…")
        } else {
            connectionStatus.title = paired ? tr("iPhone：接続済み", "iPhone: Connected") : tr("iPhone：未接続", "iPhone: Disconnected")
        }
        unpairItem.isEnabled = paired
        proItem.title = isPro ? tr("PROライセンス", "PRO License") : tr("PRO版にアップデートする", "Upgrade to PRO")
    }

    private func refreshLicenseState() {
        guard agent?.isRunning == true, !checkingLicenseState else { return }
        checkingLicenseState = true
        var request = URLRequest(url: localURL.appendingPathComponent("admin/license"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.checkingLicenseState = false
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let data,
                      let state = try? JSONDecoder().decode(LicenseSummary.self, from: data) else {
                    return
                }
                self.isPro = state.plan == "pro"
                self.updateConnectionMenu()
            }
        }.resume()
    }

    @objc private func showPairing() {
        whenReady { [weak self] in self?.requestQR(path: "admin/pairing", title: tr("ペアリング開始", "Start Pairing"), detail: tr("5分以内にiPhoneのカメラで読み取ってペアリングしてください", "Scan this with the iPhone camera within 5 minutes to pair.")) }
    }

    @objc private func showShareSetup() {
        guard paired else { showPairing(); return }
        whenReady { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(self.localURL.appendingPathComponent("setup-guide"))
        }
    }

    private func removeLegacyFinderQuickAction() {
        let workflow = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Services/iPhoneへ送る.workflow", isDirectory: true)
        guard FileManager.default.fileExists(atPath: workflow.path) else { return }
        do {
            try FileManager.default.removeItem(at: workflow)
            NSUpdateDynamicServices()
        } catch {
            // Cleanup is best-effort. The iPhone Data Sharing app no longer exposes or recreates this Quick Action.
        }
    }

    @objc private func showDetails() {
        whenReady { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(self.localURL.appendingPathComponent("pro"))
        }
    }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "iPhone Data Sharing"
        alert.informativeText = usesJapaneseUI
            ? "バージョン \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "開発版")\n同じLAN内でiPhoneとMacの間のファイルを転送します。"
            : "Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Development")\nTransfer files between iPhone and Mac over the same LAN."
        alert.runModal()
    }

    @objc private func unpair() {
        whenReady { [weak self] in
            guard let self else { return }
            var request = URLRequest(url: self.localURL.appendingPathComponent("admin/unpair"))
            request.httpMethod = "POST"
            request.timeoutInterval = 5
            URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if (response as? HTTPURLResponse)?.statusCode == 200 {
                        self.paired = false
                        self.updateConnectionMenu()
                        self.showPairing()
                    } else { self.showError(tr("ベアリングを解除できませんでした。", "Could not unpair the device.")) }
                }
            }.resume()
        }
    }

    private func requestQR(path: String, title: String, detail: String) {
        var request = URLRequest(url: localURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let result = try? JSONDecoder().decode(PairingResponse.self, from: data) else {
                DispatchQueue.main.async { self?.showError("QR を作れませんでした: \(error?.localizedDescription ?? "接続エラー")") }
                return
            }
            DispatchQueue.main.async { self?.presentQR(result.url, title: title, detail: detail) }
        }.resume()
    }

    private func presentQR(_ value: String, title windowTitle: String, detail message: String) {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 10, y: 10)), from: output.extent.applying(CGAffineTransform(scaleX: 10, y: 10))) else {
            showError(tr("QR 画像を生成できませんでした。", "Could not generate the QR code."))
            return
        }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: 300, height: 300))
        // Keep the window alive after closing. Releasing it during AppKit's close animation
        // caused a crash in _NSWindowTransformAnimation dealloc.
        let height: CGFloat = 430
        let window = pairingWindow ?? NSWindow(contentRect: NSRect(x: 0, y: 0, width: 430, height: height),
                                                styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.setContentSize(NSSize(width: 430, height: height))
        window.title = windowTitle
        window.center()

        let content = NSView(frame: window.contentView!.bounds)
        let title = NSTextField(labelWithString: tr("iPhone のカメラで読み取ってください", "Scan with your iPhone camera"))
        title.font = .boldSystemFont(ofSize: 16)
        title.alignment = .center
        title.frame = NSRect(x: 15, y: height - 47, width: 400, height: 28)
        content.addSubview(title)
        let qr = NSImageView(frame: NSRect(x: 65, y: 62, width: 300, height: 300))
        qr.image = image
        qr.imageScaling = .scaleProportionallyUpOrDown
        content.addSubview(qr)
        let detail = NSTextField(labelWithString: message)
        detail.alignment = .center
        detail.frame = NSRect(x: 15, y: 29, width: 400, height: 22)
        content.addSubview(detail)
        let address = NSTextField(labelWithString: "接続先: \(URL(string: value)?.host ?? "不明")")
        address.alignment = .center
        address.textColor = .secondaryLabelColor
        address.frame = NSRect(x: 10, y: 8, width: 410, height: 20)
        content.addSubview(address)
        window.contentView = content
        pairingWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "iPhone Data Sharing"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    @objc private func quit() {
        agent?.terminationHandler = nil
        if agent?.isRunning == true { agent?.terminate() }
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
