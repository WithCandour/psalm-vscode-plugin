import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'mz/child_process';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, StreamInfo } from 'vscode-languageclient';
import { DocumentSelector } from 'vscode-languageserver-protocol';
import * as semver from 'semver';
import * as net from 'net';
import * as url from 'url';
import * as fs from 'fs';

import { registerCommands } from './commands';

async function showOpenSettingsPrompt(errorMessage: string): Promise<void> {
    const selected = await vscode.window.showErrorMessage(
        errorMessage,
        'Open settings'
    );
    if (selected === 'Open settings') {
        await vscode.commands.executeCommand('workbench.action.openGlobalSettings');
    }
}

function isFile(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile();
    } catch (e) {
        return false;
    }
}

function filterPath(paths: string[], workspacePath: string): string|null {
    for (const configPath of paths) {
        if (isFile(path.join(workspacePath, configPath))) {
            return configPath;
        }
    }

    return null;
}

// Returns true if psalm.psalmScriptPath supports the language server protocol.
async function checkPsalmHasLanguageServer(
    context: vscode.ExtensionContext,
    phpExecutablePath: string,
    psalmScriptPath: string
): Promise<boolean> {
    const exists: boolean = isFile(psalmScriptPath);

    if (!exists) {
        await showOpenSettingsPrompt('The setting psalm.psalmScriptPath refers to a path that does not exist. path: ' + psalmScriptPath);
        return false;
    }

    return true;
}

async function checkPsalmLanguageServerHasOption(
    context: vscode.ExtensionContext,
    phpExecutablePath: string,
    phpExecutableArgs: string|string[]|null,
    psalmScriptPath: string,
    psalmScriptArgs: string[],
    option: string
): Promise<boolean> {
    let stdout: string;
    try {
        const args: string[] = [ '-f', psalmScriptPath, '--', '--help', ...psalmScriptArgs ];
        if (phpExecutableArgs) {
            if (typeof phpExecutableArgs === 'string' && phpExecutableArgs.trim().length > 0) {
                args.unshift(phpExecutableArgs);
            } else if (Array.isArray(phpExecutableArgs) && phpExecutableArgs.length > 0) {
                args.unshift(...phpExecutableArgs);
            }
        }
        [stdout] = await execFile(phpExecutablePath, args);
        return (new RegExp('(\\b|\\s)' + escapeRegExp(option) + '(?![-_])(\\b|\\s)', 'm')).test(stdout);
    } catch (err) {
        return false;
    }
}

function escapeRegExp(str: string) {
    return str.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const conf = vscode.workspace.getConfiguration('psalm');
    const phpExecutablePath = conf.get<string>('phpExecutablePath') || 'php';
    let phpExecutableArgs = conf.get<string>('phpExecutableArgs') ||
        [
            '-dxdebug.remote_autostart=0',
            '-dxdebug.remote_enable=0',
            '-dxdebug_profiler_enable=0'
        ];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const defaultPsalmClientScriptPath = path.join('vendor', 'vimeo', 'psalm', 'psalm');
    const defaultPsalmServerScriptPath = path.join('vendor', 'vimeo', 'psalm', 'psalm-language-server');
    let psalmClientScriptPath = conf.get<string>('psalmClientScriptPath') || defaultPsalmClientScriptPath;
    let psalmServerScriptPath = conf.get<string>('psalmScriptPath') || defaultPsalmServerScriptPath;
    const enableIniDefaults = conf.get<boolean>('enableIniDefaults') || false;
    const unusedVariableDetection = conf.get<boolean>('unusedVariableDetection') || false;
    const enableDebugLog = true; // conf.get<boolean>('enableDebugLog') || false;
    const connectToServerWithTcp = conf.get<boolean>('connectToServerWithTcp');
    const analyzedFileExtensions: undefined|string[]|DocumentSelector = conf.get<string[]|DocumentSelector>('analyzedFileExtensions') ||
        [
            { scheme: 'file', language: 'php' },
            { scheme: 'untitled', language: 'php' }
        ];
    const psalmConfigPaths: string[] = conf.get<string[]>('configPaths') || ['psalm.xml', 'psalm.xml.dist'];
    let hideStatusMessageWhenRunning: boolean = conf.get<boolean>('hideStatusMessageWhenRunning') || false;

    // Check if the psalmServerScriptPath setting was provided.
    if (!psalmServerScriptPath) {
        await showOpenSettingsPrompt('The setting psalm.psalmScriptPath must be provided (e.g. vendor/bin/psalm-language-server)');
        return;
    }

    // Check if the psalmClientScriptPath setting was provided.
    if (!psalmClientScriptPath) {
        await showOpenSettingsPrompt('The setting psalm.psalmClientScriptPath must be provided (e.g. vendor/bin/psalm)');
        return;
    }

    if (!workspaceFolders) {
        await showOpenSettingsPrompt('Psalm must be run in a workspace');
        return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;

    if (!isFile(psalmServerScriptPath)) {
        psalmServerScriptPath = path.join(workspacePath, psalmServerScriptPath);
    }
    if (!isFile(psalmClientScriptPath)) {
        psalmClientScriptPath = path.join(workspacePath, psalmClientScriptPath);
    }

    // Check if psalm is installed and supports the language server protocol.
    const isValidPsalmVersion: boolean = await checkPsalmHasLanguageServer(context, phpExecutablePath, psalmServerScriptPath);
    if (!isValidPsalmVersion) {
        return;
    }

    // Check path (if PHP is available and version is ^7.0.0)
    let stdout: string;
    try {
        [stdout] = await execFile(phpExecutablePath, ['--version']);
    } catch (err) {
        if (err.code === 'ENOENT') {
            await showOpenSettingsPrompt('PHP executable not found. Install PHP 7 and add it to your PATH or set the php.executablePath setting');
        } else {
            vscode.window.showErrorMessage('Error spawning PHP: ' + err.message);
            console.error(err);
        }
        return;
    }

    // Parse version and discard OS info like 7.0.8--0ubuntu0.16.04.2
    const match = stdout.match(/^PHP ([^\s]+)/m);
    if (!match) {
        vscode.window.showErrorMessage('Error parsing PHP version. Please check the output of php --version');
        return;
    }
    let version = match[1].split('-')[0];
    // Convert PHP prerelease format like 7.0.0rc1 to 7.0.0-rc1
    if (!/^\d+.\d+.\d+$/.test(version)) {
        version = version.replace(/(\d+.\d+.\d+)/, '$1-');
    }
    if (semver.lt(version, '7.0.0')) {
        vscode.window.showErrorMessage('The language server needs at least PHP 7 installed. Version found: ' + version);
        return;
    }

    if (phpExecutableArgs) {
        if (typeof phpExecutableArgs === 'string' && phpExecutableArgs.trim().length > 0) {
            phpExecutableArgs = phpExecutableArgs.trim();
            if (phpExecutableArgs === '--') {
                phpExecutableArgs = [];
            }
        } else if (Array.isArray(phpExecutableArgs) && phpExecutableArgs.length > 0) {
            phpExecutableArgs = phpExecutableArgs
                .map((v) => v.trim())
                .filter((v) => v.length > 0 && v !== '--');
        }
    } else {
        phpExecutableArgs = [];
    }

    const psalmConfigPath = filterPath(psalmConfigPaths, workspacePath);
    if (psalmConfigPath === null) {
        vscode.window.showWarningMessage(
            'No psalm.xml config found in project root. Want to configure one?',
            'Yes', 'No'
        ).then(async result => {
            if (result == 'Yes') {
                await execFile(phpExecutablePath, [psalmClientScriptPath, '--init'], {cwd: workspacePath});
                vscode.window.showInformationMessage(
                    "Psalm configuration has been initialized. Reload window in order for configuration to take effect.",
                    "Reload window"
                ).then(result => {
                    if (result == "Reload window") {
                        vscode.commands.executeCommand("workbench.action.reloadWindow");
                    }
                });
            }
        });
        return;
    }

    const psalmHasLanguageServerOption: boolean =
        await checkPsalmLanguageServerHasOption(context, phpExecutablePath, phpExecutableArgs, psalmServerScriptPath, [], '--language-server');
    const psalmScriptArgs = psalmHasLanguageServerOption ? ['--language-server'] : [];
    const psalmHasExtendedDiagnosticCodes: boolean =
        await checkPsalmLanguageServerHasOption(context, phpExecutablePath, phpExecutableArgs, psalmServerScriptPath, psalmScriptArgs,
            '--use-extended-diagnostic-codes');
    const psalmHasVerbose: boolean = enableDebugLog ?
        await checkPsalmLanguageServerHasOption(context, phpExecutablePath, phpExecutableArgs, psalmServerScriptPath, psalmScriptArgs,
            '--verbose') : false;
    const psalmHasIniDefaults: boolean = enableIniDefaults ?
        await checkPsalmLanguageServerHasOption(context, phpExecutablePath, phpExecutableArgs, psalmServerScriptPath, psalmScriptArgs,
            '--use-ini-defaults') : false;

    const serverOptionsCallbackForDirectory = (dirToAnalyze: string) => (() => new Promise<ChildProcess | StreamInfo>((resolve, reject) => {
        // Listen on random port
        const spawnServer = (...args: string[]): ChildProcess => {
            if (unusedVariableDetection) {
                args.unshift('--find-dead-code');
            }

            if (psalmHasVerbose && enableDebugLog) {
                args.unshift('--verbose');
            }

            if (psalmHasIniDefaults && enableIniDefaults) {
                args.unshift('--use-ini-defaults');
            }

            if (psalmHasExtendedDiagnosticCodes) {
                // this will add the help link to the diagnostic issue
                args.unshift('--use-extended-diagnostic-codes');
            }

            args.unshift('-r', workspacePath);

            args.unshift('-c', path.join(workspacePath, psalmConfigPath));

            args.unshift(...psalmScriptArgs);

            // end of the psalm language server arguments, so we use the php cli argument separator
            args.unshift('--');

            // The server is implemented in PHP
            // this goes before the cli argument separator
            args.unshift('-f', psalmServerScriptPath);

            if (phpExecutableArgs) {
                if (Array.isArray(phpExecutableArgs)) {
                    args.unshift(...phpExecutableArgs);
                } else {
                    args.unshift(phpExecutableArgs);
                }
            }

            console.log('starting Psalm Language Server', phpExecutablePath, args);

            const childProcess = spawn(phpExecutablePath, args, {cwd: dirToAnalyze});
            childProcess.stderr.on('data', (chunk: Buffer) => {
                console.error(chunk + '');
            });
            if (enableDebugLog) {
                childProcess.stdin.on('data', (chunk: Buffer) => {
                    console.log('in: ' + chunk);
                });
                childProcess.stdout.on('data', (chunk: Buffer) => {
                    console.log('out: ' + chunk);
                });
            }
            childProcess.on('exit', (code, signal) => {
                console.log('Psalm Language Server exited: ' + code + ':' + signal);
            });
            return childProcess;
        };
        // Use a TCP socket on Windows because of problems with blocking STDIO
        // stdio locks up for large responses
        // (based on https://github.com/felixfbecker/vscode-php-intellisense/commit/ddddf2a178e4e9bf3d52efb07cd05820ce109f43)
        if (connectToServerWithTcp || process.platform === 'win32') {
            const server = net.createServer(socket => {
                // 'connection' listener
                console.log('PHP process connected');
                socket.on('end', () => {
                    console.log('PHP process disconnected');
                });
                server.close();
                resolve({ reader: socket, writer: socket });
            });
            server.listen(0, '127.0.0.1', () => {
                // Start the language server and make the language server connect to the client listening on <addr> (e.g. 127.0.0.1:<port>)
                spawnServer('--tcp=127.0.0.1:' + server.address().port);
            });
        } else {
            // Use STDIO on Linux / Mac if the user set
            // the override `"psalm.connectToServerWithTcp": false` in their config.
            resolve(spawnServer());
        }
    }));

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for php (and maybe HTML) documents
        documentSelector: analyzedFileExtensions,
        uriConverters: {
            // VS Code by default %-encodes even the colon after the drive letter
            // NodeJS handles it much better
            code2Protocol: uri => url.format(url.parse(uri.toString(true))),
            protocol2Code: str => vscode.Uri.parse(str)
        },
        synchronize: {
            // Synchronize the setting section 'psalm' to the server (TODO: server side support)
            configurationSection: 'psalm',
            fileEvents: [
                vscode.workspace.createFileSystemWatcher('**/' + psalmConfigPath),
                // this is for when files get changed outside of vscode
                vscode.workspace.createFileSystemWatcher('**/*.php'),
            ]
        },
        progressOnInitialization: true,

    };

    // this has a low priority so it will end up being more towards the right.
    const psalmStatusBar: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    psalmStatusBar.text = ' $(loading~spin) Psalm: starting';
    psalmStatusBar.tooltip = 'Psalm Language Server';
    psalmStatusBar.show();

    // Create the language client and start the client.
    const lc = new LanguageClient(
        'psalmLanguageServer',
        'Psalm Language Server',
        serverOptionsCallbackForDirectory(workspacePath),
        clientOptions
    );

    lc.onTelemetry((params) => {
        if (typeof params === 'object' && 'message' in params && typeof params.message === 'string') {

            // each time we get a new telemetry, we are going to check the config, and update as needed
            hideStatusMessageWhenRunning = conf.get<boolean>('hideStatusMessageWhenRunning') || false;

            let status: string = params.message;

            if (params.message.indexOf(':') >= 0) {
                status = params.message.split(':')[0];
            }

            let statusIcon = '';

            switch (status) {
                case 'initializing':
                    statusIcon = '$(sync~spin)';
                    break;
                case 'initialized':
                    statusIcon = '$(zap)';
                    break;
                case 'running':
                    statusIcon = '$(check)';
                    break;
                case 'analyzing':
                    statusIcon = '$(sync~spin)';
                    break;
                case 'closing':
                    statusIcon = '$(issues)';
                    break;
                case 'closed':
                    statusIcon = '$(error)';
                    break;
            }

            psalmStatusBar.text = (statusIcon + ' Psalm: ' + params.message).trim();
            if (hideStatusMessageWhenRunning && status === 'running') {
                psalmStatusBar.hide();
            } else {
                psalmStatusBar.show();
            }

        }
    });

    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    const disposable = lc.start();
    context.subscriptions.push(...registerCommands(lc), disposable);

    await lc.onReady();

    psalmStatusBar.text = '$(check) Psalm: running';
    if (hideStatusMessageWhenRunning) {
        psalmStatusBar.hide();
    } else {
        psalmStatusBar.show();
    }
}
