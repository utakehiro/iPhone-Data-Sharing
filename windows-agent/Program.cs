using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Media;
using System.Net;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Windows.Forms;

namespace IPhoneDataSharing.Windows;

internal sealed record PairingResponse(string url, string qr);
internal sealed record PairingState(bool paired, int receivedCount);
internal sealed record DownloadDirectory(string directory);
internal sealed record LicenseState(string plan);

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var singleInstance = new Mutex(initiallyOwned: true, @"Local\IPhoneDataSharing.Windows.Tray", out var createdNew);
        if (!createdNew) return;

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private const int Port = 3000;
    private readonly Uri _localUrl = new($"http://127.0.0.1:{Port}/");
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _connectItem;
    private readonly ToolStripMenuItem _sendItem;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _unpairItem;
    private readonly ToolStripMenuItem _proItem;
    private readonly System.Windows.Forms.Timer _pollTimer;
    private Process? _agent;
    private bool _ownsAgent;
    private bool _paired;
    private bool _isPro;
    private int? _lastReceivedCount;
    private bool _didInitialState;
    private bool _pollInProgress;
    private Form? _pairingForm;
    private readonly object _logLock = new();

    private static readonly string Lang = SupportedLanguage();
    private static readonly Dictionary<string, Dictionary<string, string>> Text = BuildTranslations();

    public TrayContext()
    {
        _http.BaseAddress = _localUrl;

        var menu = new ContextMenuStrip();

        _connectItem = new ToolStripMenuItem(L("connect"), null, async (_, _) => await ShowPairingAsync());
        _sendItem = new ToolStripMenuItem(L("send"), null, (_, _) => OpenUrl("transfer"));

        menu.Items.Add(_connectItem);
        menu.Items.Add(_sendItem);
        menu.Items.Add(new ToolStripSeparator());

        var settings = new ToolStripMenuItem(L("settings"));
        _statusItem = new ToolStripMenuItem(L("disconnected")) { Enabled = false };
        settings.DropDownItems.Add(_statusItem);
        settings.DropDownItems.Add(new ToolStripMenuItem(L("setup"), null, (_, _) => OpenUrl("setup-guide")));

        _unpairItem = new ToolStripMenuItem(L("unpair"), null, async (_, _) => await UnpairAsync());
        settings.DropDownItems.Add(_unpairItem);
        settings.DropDownItems.Add(new ToolStripSeparator());

        _proItem = new ToolStripMenuItem(L("upgrade"), null, (_, _) => OpenUrl("pro"));
        settings.DropDownItems.Add(_proItem);
        settings.DropDownOpening += async (_, _) =>
        {
            await RefreshStateAsync(showPairingIfNeeded: false);
            await RefreshLicenseAsync();
        };
        menu.Items.Add(settings);

        menu.Items.Add(new ToolStripMenuItem(L("destination"), null, async (_, _) => await ChooseDownloadDirectoryAsync()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem(L("about"), null, (_, _) => ShowAbout()));
        menu.Items.Add(new ToolStripMenuItem(L("quit"), null, (_, _) => Exit()));

        var applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        _tray = new NotifyIcon
        {
            Text = "iPhone Data Sharing",
            Icon = applicationIcon ?? SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => OpenUrl("transfer");

        UpdateMenu();

        try
        {
            StartOrAttachAgent();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        _pollTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        _pollTimer.Tick += async (_, _) =>
        {
            if (_pollInProgress) return;
            _pollInProgress = true;
            try
            {
                await RefreshStateAsync(showPairingIfNeeded: true);
                await RefreshLicenseAsync();
            }
            finally
            {
                _pollInProgress = false;
            }
        };
        _pollTimer.Start();
    }

    private static string SupportedLanguage()
    {
        var code = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.ToLowerInvariant();
        return new[] { "ja", "en", "zh", "ko", "es", "fr", "de" }.Contains(code) ? code : "en";
    }

    private static Dictionary<string, Dictionary<string, string>> BuildTranslations() => new()
    {
        ["en"] = new()
        {
            ["connect"]="Connect iPhone", ["send"]="Send Files to iPhone", ["settings"]="Connection & Settings",
            ["disconnected"]="iPhone: Disconnected", ["connected"]="iPhone: Connected", ["checking"]="iPhone: Checking…",
            ["setup"]="Transfer Setup", ["unpair"]="Unpair", ["upgrade"]="Upgrade to PRO", ["pro"]="PRO License",
            ["destination"]="Received File Location", ["about"]="About iPhone Data Sharing", ["quit"]="Quit iPhone Data Sharing",
            ["pairTitle"]="Start Pairing", ["pairDetail"]="Scan this QR code with your iPhone camera within 5 minutes.",
            ["chooseFolder"]="Choose where files received from iPhone should be saved.", ["confirmUnpair"]="Unpair this iPhone?",
            ["received"]="New file received from iPhone.", ["firewall"]="Allow iPhone Data Sharing through Windows Firewall on private networks?",
            ["shortcutsMissing"]="Signed iPhone shortcut templates are missing. Build them on macOS before creating the Windows package.",
            ["portBusy"]="Port 3000 is already in use by another application.", ["agentMissing"]="The packaged iPhone Data Sharing Agent could not be found.",
        },
        ["ja"] = new()
        {
            ["connect"]="iPhoneを接続", ["send"]="iPhoneにファイルを送る", ["settings"]="接続・設定",
            ["disconnected"]="iPhone：未接続", ["connected"]="iPhone：接続済み", ["checking"]="iPhone：確認中…",
            ["setup"]="送受信設定情報", ["unpair"]="ペアリングを解除", ["upgrade"]="PRO版にアップデートする", ["pro"]="PROライセンス",
            ["destination"]="受信ファイルの保存先", ["about"]="iPhone Data Sharingについて", ["quit"]="iPhone Data Sharingを終了",
            ["pairTitle"]="ペアリング開始", ["pairDetail"]="5分以内にiPhoneのカメラでQRを読み取ってください。",
            ["chooseFolder"]="iPhoneから受け取ったファイルの保存先を選択してください。", ["confirmUnpair"]="iPhoneとのペアリングを解除しますか？",
            ["received"]="iPhoneから新しいファイルを受信しました。", ["firewall"]="プライベートネットワークでiPhone Data Sharingの通信をWindows Firewallに許可しますか？",
            ["shortcutsMissing"]="署名済みiPhoneショートカットがありません。Windowsパッケージを作る前にmacOSで生成してください。",
            ["portBusy"]="ポート3000をほかのアプリが使用しています。", ["agentMissing"]="iPhone Data Sharing Agentの実行ファイルが見つかりません。",
        },
        ["zh"] = new()
        {
            ["connect"]="连接 iPhone", ["send"]="发送文件到 iPhone", ["settings"]="连接与设置",
            ["disconnected"]="iPhone：未连接", ["connected"]="iPhone：已连接", ["checking"]="iPhone：检查中…",
            ["setup"]="传输设置", ["unpair"]="取消配对", ["upgrade"]="升级到 PRO", ["pro"]="PRO 许可证",
            ["destination"]="接收文件保存位置", ["about"]="关于 iPhone Data Sharing", ["quit"]="退出 iPhone Data Sharing",
            ["pairTitle"]="开始配对", ["pairDetail"]="请在5分钟内用iPhone相机扫描二维码。",
            ["chooseFolder"]="选择从iPhone接收文件的保存位置。", ["confirmUnpair"]="要取消与此iPhone的配对吗？",
            ["received"]="已从iPhone接收新文件。", ["firewall"]="允许iPhone Data Sharing通过Windows防火墙访问专用网络吗？",
        },
        ["ko"] = new()
        {
            ["connect"]="iPhone 연결", ["send"]="iPhone으로 파일 보내기", ["settings"]="연결 및 설정",
            ["disconnected"]="iPhone: 연결 안 됨", ["connected"]="iPhone: 연결됨", ["checking"]="iPhone: 확인 중…",
            ["setup"]="전송 설정", ["unpair"]="페어링 해제", ["upgrade"]="PRO로 업그레이드", ["pro"]="PRO 라이선스",
            ["destination"]="수신 파일 저장 위치", ["about"]="iPhone Data Sharing 정보", ["quit"]="iPhone Data Sharing 종료",
            ["pairTitle"]="페어링 시작", ["pairDetail"]="5분 이내에 iPhone 카메라로 QR 코드를 스캔하세요.",
            ["chooseFolder"]="iPhone에서 받은 파일의 저장 위치를 선택하세요.", ["confirmUnpair"]="이 iPhone과의 페어링을 해제할까요?",
            ["received"]="iPhone에서 새 파일을 받았습니다.", ["firewall"]="개인 네트워크에서 iPhone Data Sharing을 Windows 방화벽에 허용할까요?",
        },
        ["es"] = new()
        {
            ["connect"]="Conectar iPhone", ["send"]="Enviar archivos al iPhone", ["settings"]="Conexión y ajustes",
            ["disconnected"]="iPhone: desconectado", ["connected"]="iPhone: conectado", ["checking"]="iPhone: comprobando…",
            ["setup"]="Configuración de transferencia", ["unpair"]="Desenlazar", ["upgrade"]="Actualizar a PRO", ["pro"]="Licencia PRO",
            ["destination"]="Ubicación de archivos recibidos", ["about"]="Acerca de iPhone Data Sharing", ["quit"]="Salir de iPhone Data Sharing",
            ["pairTitle"]="Iniciar enlace", ["pairDetail"]="Escanea el QR con la cámara del iPhone en menos de 5 minutos.",
            ["chooseFolder"]="Elige dónde guardar los archivos recibidos del iPhone.", ["confirmUnpair"]="¿Desenlazar este iPhone?",
            ["received"]="Se recibió un archivo nuevo del iPhone.", ["firewall"]="¿Permitir iPhone Data Sharing en el Firewall de Windows para redes privadas?",
        },
        ["fr"] = new()
        {
            ["connect"]="Connecter l’iPhone", ["send"]="Envoyer des fichiers à l’iPhone", ["settings"]="Connexion et réglages",
            ["disconnected"]="iPhone : déconnecté", ["connected"]="iPhone : connecté", ["checking"]="iPhone : vérification…",
            ["setup"]="Configuration du transfert", ["unpair"]="Dissocier", ["upgrade"]="Passer à PRO", ["pro"]="Licence PRO",
            ["destination"]="Emplacement des fichiers reçus", ["about"]="À propos de iPhone Data Sharing", ["quit"]="Quitter iPhone Data Sharing",
            ["pairTitle"]="Démarrer l’association", ["pairDetail"]="Scannez le QR avec l’appareil photo de l’iPhone dans les 5 minutes.",
            ["chooseFolder"]="Choisissez où enregistrer les fichiers reçus de l’iPhone.", ["confirmUnpair"]="Dissocier cet iPhone ?",
            ["received"]="Nouveau fichier reçu de l’iPhone.", ["firewall"]="Autoriser iPhone Data Sharing dans le pare-feu Windows sur les réseaux privés ?",
        },
        ["de"] = new()
        {
            ["connect"]="iPhone verbinden", ["send"]="Dateien an iPhone senden", ["settings"]="Verbindung & Einstellungen",
            ["disconnected"]="iPhone: getrennt", ["connected"]="iPhone: verbunden", ["checking"]="iPhone: wird geprüft…",
            ["setup"]="Übertragung einrichten", ["unpair"]="Kopplung aufheben", ["upgrade"]="Auf PRO upgraden", ["pro"]="PRO-Lizenz",
            ["destination"]="Speicherort empfangener Dateien", ["about"]="Über iPhone Data Sharing", ["quit"]="iPhone Data Sharing beenden",
            ["pairTitle"]="Kopplung starten", ["pairDetail"]="Scanne den QR-Code innerhalb von 5 Minuten mit der iPhone-Kamera.",
            ["chooseFolder"]="Wähle den Speicherort für vom iPhone empfangene Dateien.", ["confirmUnpair"]="Kopplung mit diesem iPhone aufheben?",
            ["received"]="Neue Datei vom iPhone empfangen.", ["firewall"]="iPhone Data Sharing in der Windows-Firewall für private Netzwerke zulassen?",
        },
    };

    private static string L(string key)
    {
        if (Text.TryGetValue(Lang, out var current) && current.TryGetValue(key, out var value)) return value;
        return Text["en"].TryGetValue(key, out var fallback) ? fallback : key;
    }

    private void StartOrAttachAgent()
    {
        if (!IsPortFree(Port))
        {
            if (TryHealthSync()) return;
            throw new InvalidOperationException(L("portBusy"));
        }

        var baseDir = AppContext.BaseDirectory;
        var resources = Path.Combine(baseDir, "resources");
        var node = Path.Combine(resources, "node.exe");
        var agent = Path.Combine(resources, "server", "dist", "local-agent.js");
        var shortcuts = Path.Combine(resources, "shortcuts");

        if (!File.Exists(node) || !File.Exists(agent))
            throw new FileNotFoundException(L("agentMissing"));

        if (!File.Exists(Path.Combine(shortcuts, "send-en.shortcut")) ||
            !File.Exists(Path.Combine(shortcuts, "receive-en.shortcut")))
        {
            MessageBox.Show(L("shortcutsMissing"), "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "iPhone Data Sharing");
        Directory.CreateDirectory(dataDir);
        EnsureFirewallRule(node, dataDir);
        var logDir = Path.Combine(dataDir, "Logs");
        Directory.CreateDirectory(logDir);

        var lan = FindPrivateLanAddress();
        var psi = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = Path.Combine(resources, "server"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(agent);
        psi.Environment["PORT"] = Port.ToString(CultureInfo.InvariantCulture);
        psi.Environment["AGENT_PARENT_PID"] = Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
        psi.Environment["HOST_PLATFORM"] = "windows";
        psi.Environment["STATIC_SHORTCUT_DIR"] = shortcuts;
        psi.Environment["DATA_DIR"] = dataDir;
        if (lan is not null) psi.Environment["PUBLIC_BASE_URL"] = $"http://{lan}:{Port}";

        _agent = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _agent.OutputDataReceived += (_, e) => AppendLog(logDir, e.Data);
        _agent.ErrorDataReceived += (_, e) => AppendLog(logDir, e.Data);
        _agent.Exited += (_, _) =>
        {
            if (_ownsAgent && _tray.Visible)
                _tray.ShowBalloonTip(4000, "iPhone Data Sharing", "iPhone Data Sharing Agent stopped.", ToolTipIcon.Warning);
        };

        if (!_agent.Start()) throw new InvalidOperationException("Could not start iPhone Data Sharing Agent.");
        _ownsAgent = true;
        _agent.BeginOutputReadLine();
        _agent.BeginErrorReadLine();
    }

    private void AppendLog(string logDir, string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        lock (_logLock)
        {
            File.AppendAllText(Path.Combine(logDir, "iPhone Data Sharing Agent.log"),
                $"{DateTimeOffset.Now:O} {line}{Environment.NewLine}");
        }
    }

    private static bool IsPortFree(int port)
    {
        TcpListener? listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch (SocketException) { return false; }
        finally { listener?.Stop(); }
    }

    private bool TryHealthSync()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
            return client.GetAsync(new Uri(_localUrl, "health")).GetAwaiter().GetResult().IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private static string? FindPrivateLanAddress()
    {
        var candidates = new List<(int score, string address)>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up ||
                nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                continue;

            var score = nic.NetworkInterfaceType switch
            {
                NetworkInterfaceType.Wireless80211 => 100,
                NetworkInterfaceType.Ethernet => 90,
                _ => 10,
            };

            foreach (var uni in nic.GetIPProperties().UnicastAddresses)
            {
                if (uni.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                var address = uni.Address.ToString();
                if (address.StartsWith("169.254.")) continue;
                var addressScore = score + (IsPrivateIPv4(uni.Address) ? 50 : 0);
                candidates.Add((addressScore, address));
            }
        }
        return candidates.OrderByDescending(x => x.score).Select(x => x.address).FirstOrDefault();
    }

    private static bool IsPrivateIPv4(IPAddress address)
    {
        var b = address.GetAddressBytes();
        return b[0] == 10 ||
               (b[0] == 172 && b[1] is >= 16 and <= 31) ||
               (b[0] == 192 && b[1] == 168);
    }

    private void EnsureFirewallRule(string nodePath, string dataDir)
    {
        const string ruleName = "iPhone Data Sharing Local Agent";
        var markerPath = Path.Combine(dataDir, "firewall-node-path.txt");
        var markerMatches = false;
        try
        {
            markerMatches = string.Equals(File.ReadAllText(markerPath).Trim(), nodePath,
                StringComparison.OrdinalIgnoreCase);
        }
        catch { }

        try
        {
            using var check = Process.Start(new ProcessStartInfo
            {
                FileName = "netsh",
                Arguments = $"advfirewall firewall show rule name=\"{ruleName}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
            });
            check?.WaitForExit(1500);
            if (check?.ExitCode == 0 && markerMatches) return;
        }
        catch { }

        if (MessageBox.Show(L("firewall"), "iPhone Data Sharing", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return;

        try
        {
            var command =
                $"netsh advfirewall firewall delete rule name=\"{ruleName}\" >nul 2>&1 & " +
                $"netsh advfirewall firewall add rule name=\"{ruleName}\" dir=in action=allow protocol=TCP " +
                $"localport={Port} profile=private program=\"{nodePath}\" enable=yes";
            using var p = Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/d /c {command}",
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            p?.WaitForExit();
            if (p?.ExitCode == 0) File.WriteAllText(markerPath, nodePath);
        }
        catch { /* User can cancel UAC; Windows may show its own firewall prompt later. */ }
    }

    private async Task RefreshStateAsync(bool showPairingIfNeeded)
    {
        try
        {
            var state = await _http.GetFromJsonAsync<PairingState>("admin/pairing-state");
            if (state is null) return;

            var wasPaired = _paired;
            _paired = state.paired;

            if (_lastReceivedCount is int previous && state.receivedCount > previous)
            {
                SystemSounds.Asterisk.Play();
                _tray.ShowBalloonTip(3000, "iPhone Data Sharing", L("received"), ToolTipIcon.Info);
            }
            _lastReceivedCount = state.receivedCount;
            UpdateMenu();

            if (_paired && _pairingForm is { IsDisposed: false })
                _pairingForm.Close();

            if (!_didInitialState)
            {
                _didInitialState = true;
                if (!_paired && showPairingIfNeeded) await ShowPairingAsync();
            }
            else if (!wasPaired && _paired)
            {
                _tray.ShowBalloonTip(2500, "iPhone Data Sharing", L("connected"), ToolTipIcon.Info);
            }
        }
        catch
        {
            _statusItem.Text = L("checking");
        }
    }

    private async Task RefreshLicenseAsync()
    {
        try
        {
            var state = await _http.GetFromJsonAsync<LicenseState>("admin/license");
            _isPro = string.Equals(state?.plan, "pro", StringComparison.OrdinalIgnoreCase);
            _proItem.Text = _isPro ? L("pro") : L("upgrade");
        }
        catch { }
    }

    private void UpdateMenu()
    {
        _connectItem.Visible = !_paired;
        _sendItem.Visible = _paired;
        _statusItem.Text = _paired ? L("connected") : L("disconnected");
        _unpairItem.Enabled = _paired;
        _proItem.Text = _isPro ? L("pro") : L("upgrade");
    }

    private async Task ShowPairingAsync()
    {
        if (_pairingForm is { IsDisposed: false })
        {
            _pairingForm.Activate();
            return;
        }

        try
        {
            var response = await _http.PostAsync("admin/pairing", content: null);
            response.EnsureSuccessStatusCode();
            var pairing = await response.Content.ReadFromJsonAsync<PairingResponse>();
            if (pairing is null) return;

            var form = new Form
            {
                Text = L("pairTitle"),
                Width = 440,
                Height = 520,
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
            };

            var title = new Label
            {
                Text = L("pairDetail"),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Left = 20,
                Top = 20,
                Width = 390,
                Height = 44,
            };

            var picture = new PictureBox
            {
                Left = 65,
                Top = 75,
                Width = 300,
                Height = 300,
                SizeMode = PictureBoxSizeMode.Zoom,
            };
            picture.Image = DecodeDataUrl(pairing.qr);

            var url = new TextBox
            {
                Left = 35,
                Top = 390,
                Width = 350,
                ReadOnly = true,
                Text = pairing.url,
            };

            form.Controls.Add(title);
            form.Controls.Add(picture);
            form.Controls.Add(url);
            _pairingForm = form;
            form.FormClosed += (_, _) =>
            {
                picture.Image?.Dispose();
                if (ReferenceEquals(_pairingForm, form)) _pairingForm = null;
            };
            form.Show();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static Image? DecodeDataUrl(string dataUrl)
    {
        try
        {
            var comma = dataUrl.IndexOf(',');
            var bytes = Convert.FromBase64String(comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl);
            using var ms = new MemoryStream(bytes);
            using var image = Image.FromStream(ms);
            return new Bitmap(image);
        }
        catch { return null; }
    }

    private void OpenUrl(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = new Uri(_localUrl, path).ToString(),
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ChooseDownloadDirectoryAsync()
    {
        string? current = null;
        try
        {
            current = (await _http.GetFromJsonAsync<DownloadDirectory>("admin/download-directory"))?.directory;
        }
        catch { }

        using var dialog = new FolderBrowserDialog
        {
            Description = L("chooseFolder"),
            UseDescriptionForTitle = true,
            SelectedPath = current ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ShowNewFolderButton = true,
        };
        if (dialog.ShowDialog() != DialogResult.OK) return;

        try
        {
            var response = await _http.PostAsJsonAsync("admin/download-directory",
                new DownloadDirectory(dialog.SelectedPath));
            if (!response.IsSuccessStatusCode)
                MessageBox.Show(await response.Content.ReadAsStringAsync(), "iPhone Data Sharing",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task UnpairAsync()
    {
        if (MessageBox.Show(L("confirmUnpair"), "iPhone Data Sharing",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

        try
        {
            var response = await _http.PostAsync("admin/unpair", null);
            if (response.IsSuccessStatusCode)
            {
                _paired = false;
                UpdateMenu();
                await ShowPairingAsync();
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "iPhone Data Sharing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static void ShowAbout()
    {
        MessageBox.Show(
            "iPhone Data Sharing for Windows\n\nLocal iPhone ↔ Windows file transfer over the same LAN.",
            "iPhone Data Sharing",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private void Exit()
    {
        _pollTimer.Stop();
        _tray.Visible = false;

        if (_ownsAgent && _agent is { HasExited: false })
        {
            try { _agent.Kill(entireProcessTree: true); }
            catch { }
        }
        _agent?.Dispose();
        _http.Dispose();
        _tray.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pollTimer.Dispose();
            _tray.Dispose();
            _http.Dispose();
            _agent?.Dispose();
        }
        base.Dispose(disposing);
    }
}
