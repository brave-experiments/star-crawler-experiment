const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

puppeteer.use(stealth_plugin());

process.on('unhandledRejection', (reason) => { if(reason && reason.name === 'TargetCloseError') return; throw reason; });

const navigation_timeout_milliseconds = 45000;
const five_seconds_milliseconds = 5000;
const network_idle_deadline_milliseconds = 30000; // measured from the load event

const brave_executable_path = '/usr/bin/brave-browser';

const args = process.argv.slice(2);


// ====================================================================================================================================================
const variation_flag_index = args.indexOf('--variation');
if(variation_flag_index === -1 || !args[variation_flag_index + 1]){
    console.error('Use ---> node Page_Collector.js --variation <num> [--profile <path>] [--extension <path>]');
    process.exit(1);
}
const variation_id = args[variation_flag_index + 1];


// ====================================================================================================================================================
const profile_flag_index = args.indexOf('--profile');
const provided_profile_path = profile_flag_index !== -1 ? args[profile_flag_index + 1] : null;

const extension_flag_index = args.indexOf('--extension');
const provided_extension_path = extension_flag_index !== -1 ? args[extension_flag_index + 1] : null;

const limit_flag_index = args.indexOf('--limit');
const provided_limit = limit_flag_index !== -1 ? parseInt(args[limit_flag_index + 1], 10) : null;
// ====================================================================================================================================================


// load config from file. Each variation carries its own region profile path.
const config_path = path.join(__dirname, 'config.json');
if(!fs.existsSync(config_path)){
    console.error('config.json not found');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(config_path, 'utf-8'));
const variation = config.variations[variation_id];

if(!variation){
    console.error(`Variation ${variation_id} not found in config.json`);
    process.exit(1);
}

const { region, profile_path, consent, resolution } = variation;
const [viewport_width, viewport_height] = resolution;




// seed profile to launch from: the CLI flag overrides the config if provided,
// otherwise the variation's region profile (with the NordVPN extension pre-connected) is used.
const seed_profile_path = provided_profile_path || profile_path;

// Consent-O-Matic is selected automatically by the variation's consent value.
const consent_extension_path = path.join(__dirname, `consent-${consent}`);

console.log(
    `Variation ${variation_id}: region=${region} consent=${consent} ` +
    `resolution=${viewport_width}x${viewport_height} profile=${seed_profile_path}`
);




//=========================================================================================================================================================
// 6 serialization points discusssed----> 
/**
 * 1. initial page response
 * 2. domcontentloaded
 * 3. pageload
 * 4. 5 seconds
 * 5. networkidle0
 * 6.networkidle2
 */
const serialization_points = ['initial_response', 'domcontentloaded', 'page_load', 'five_seconds', 'networkidle2', 'networkidle0'];
//=========================================================================================================================================================


//output dirs
const variation_directory = path.join(__dirname, 'output', `variation_${variation_id}`);
const profile_directory = path.join(variation_directory, 'profile');
const websites_directory = path.join(variation_directory, 'websites');

for (const directory of [variation_directory, websites_directory]){
    if(!fs.existsSync(directory)){
        fs.mkdirSync(directory, { recursive: true });
    }
}






/**
 * Profile: copy the region's pre-configured profile into the run profile dir and launch
            from the copy so the source stays pristine. Singleton lock files are stripped so the
            copy launches cleanly. If no seed profile is set, start from a fresh empty profile dir.
 */
function prepare_profile_directory(){
    fs.rmSync(profile_directory, { recursive: true, force: true });

    if(seed_profile_path){
        if(!fs.existsSync(seed_profile_path)){
            console.error(`Seed profile not found at ${seed_profile_path}`);
            process.exit(1);
        }
        // fs.cpSync(seed_profile_path, profile_directory, { recursive: true });
        require('child_process').execSync(`cp -a "${seed_profile_path}/." "${profile_directory}/"`);

        for (const lock_file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']){
            fs.rmSync(path.join(profile_directory, lock_file), { force: true });
        }

        console.log(`Profile seeded from ${seed_profile_path}`);
    } else {
        fs.mkdirSync(profile_directory, { recursive: true });
    }
}



// ------> directory naming e.g. domain.example.com is stored at ./domain_example_com
function sanitize_for_filesystem(value){
    return value.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.]/g, '_');
}

// TODO: See if we missed any flag to ensure reproducability across crawls
function build_browser_args(){
    const browser_args = [
        '--disable-blink-features=AutomationControlled',
        '--disable-field-trial-config',
        '--disable-features=VizDisplayCompositor,HttpsUpgrades,ThirdPartyStoragePartitioning,Translate,OptimizationHints',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-extensions-file-access-check',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-back-forward-cache',
        '--disable-component-update',
        '--disable-client-side-phishing-detection',
        '--disable-breakpad',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-prompt-on-repost',
        '--deny-permission-prompts',
        '--disable-notifications',
        '--no-service-autorun',
        '--password-store=basic',
        '--metrics-recording-only',
        '--disable-popup-blocking',
        `--window-size=${viewport_width},${viewport_height}`,
    ];

    // Consent-O-Matic (unless no-action) plus any --extension.
    const extension_paths = [];
    if(consent !== 'no-action'){
        extension_paths.push(consent_extension_path);
    }


    if(provided_extension_path){
        extension_paths.push(path.resolve(provided_extension_path));
    }



    if(extension_paths.length > 0){
        const joined = extension_paths.join(',');
        // -----------> Consent-O-Matic on top of the profile. WE RUN WITHOUT --disable-extensions-except because 
        // it would disable the NordVPN extension that lives in the seeded profile and drop the VPN.
        browser_args.push(`--load-extension=${joined}`);
    }

    return browser_args;
}





/**
 * Spawn Brave "manually" isntead of puppeteer.launch ---> the nordvpn extension was extension was
 * dropped when puppeteer.launch started Brave (it rewrites the profile on startup). Spawning ourselves keeps the extension, 
 * ---->but spawn() returns before Brave's debug port is ready, so this polls until the port answers before we connect.
 */
function wait_for_debugger(port){
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const poll = () => {
            const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
                response.resume();
                resolve();
            });
            request.on('error', () => {
                attempts += 1;
                if(attempts > 60){
                    return reject(new Error('Brave debugging endpoint never came up'));
                }
                setTimeout(poll, 500);
            });
        };
        poll();
    });
}

// Capture the serialized DOM at one point into its own directory.
function serialize_to(point_name, domain_output_directory, html_content){
    const point_directory = path.join(domain_output_directory, point_name);
    if(!fs.existsSync(point_directory)){
        fs.mkdirSync(point_directory, { recursive: true });
    }
    fs.writeFileSync(path.join(point_directory, 'page.html'), html_content, 'utf-8');
    console.log(`  [${point_name}] HTML saved (${html_content.length} bytes)`);
    return html_content.length;
}












//Core crawl: one visit =========> 6 SERIALIZATION POINTS
async function crawl_domain(domain, browser){


    const url = domain.startsWith('http') ? domain : `https://${domain}`;
    const sanitized_domain = sanitize_for_filesystem(domain);
    const domain_output_directory = path.join(websites_directory, sanitized_domain);
    
    
    if(!fs.existsSync(domain_output_directory)){
        fs.mkdirSync(domain_output_directory, { recursive: true });
    }


    // metadata for each page/visited domain
    const metadata = {
        url,
        domain,
        timestamp: new Date().toISOString(),
        variation_id,
        region,
        consent,
        resolution: `${viewport_width}x${viewport_height}`,
        serialization_points,
        success: false,
        failure_reason: null,
        http_status: null,
        http_error: false,
        user_agent: null,
        load_event_fired: false,
        networkidle2_timed_out: false,
        networkidle0_timed_out: false,
        html_size_bytes: {}
    };

    
    
    
    console.log(`\n--- ${domain} ---`);
    const page = await browser.newPage();


    await page.setViewport({ width: viewport_width, height: viewport_height });
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com' });
    
    
    // lets see what UAs we get
    metadata.user_agent = await page.evaluate(() => navigator.userAgent).catch(() => null);

    // keep the FINAL main document response so status and raw server HTML survive even a later timeout
    let main_document_response = null;
    page.on('response', (response) => {
        if(response.request().isNavigationRequest() &&
            response.frame() === page.mainFrame() &&
            response.request().resourceType() === 'document'){
            main_document_response = response;
        }
    });

    // load fires after domcontentloaded ----------->  wait on it and record whether it fired
    let load_event_fired = false;
    const load_event_promise = new Promise((resolve) => page.once('load', () => { load_event_fired = true; resolve(); }));

    try {
        // return at domcontentloaded so a slow load cannot block the later captures
        console.log(`  Navigating to ${url}...`);
        const navigation_response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigation_timeout_milliseconds });

        const status_response = navigation_response || main_document_response;
        if(status_response){
            metadata.http_status = status_response.status();
            metadata.http_error = status_response.status() >= 400;

            // [SERIALIZATION POINT 1]: raw server HTML before client side rendering
            const initial_response_html = await status_response.text().catch(() => null);
            if(initial_response_html !== null){
                metadata.html_size_bytes.initial_response = serialize_to('initial_response', domain_output_directory, initial_response_html);
            }
        }

        
        
        
        // [SERIALIZATION POINT 2]: DOM at domcontentloaded (goto resolved here)
        metadata.html_size_bytes.domcontentloaded = serialize_to('domcontentloaded', domain_output_directory, await page.content());

        const idle_reference_timestamp = Date.now();

        
        
        
        // wait for the load event, capped within the idle deadline
        await Promise.race([
            load_event_promise,
            new Promise((resolve) => setTimeout(resolve, network_idle_deadline_milliseconds))
        ]);
        metadata.load_event_fired = load_event_fired;

        
        
        
        // [SERIALIZATION POINT 3]: DOM at load
        metadata.html_size_bytes.page_load = serialize_to('page_load', domain_output_directory, await page.content());

        
        
        
        // [SERIALIZATION POINT 4]: 5 seconds after load
        await new Promise(resolve => setTimeout(resolve, five_seconds_milliseconds));
        metadata.html_size_bytes.five_seconds = serialize_to('five_seconds', domain_output_directory, await page.content());

        
        
        
        
        // [[SERIALIZATION POINT 5] : networkidle2 (<=2 in flight), capped within the deadline
        const remaining_for_networkidle2 = network_idle_deadline_milliseconds - (Date.now() - idle_reference_timestamp);
        if(remaining_for_networkidle2 > 0){
            await page.waitForNetworkIdle({ concurrency: 2, timeout: remaining_for_networkidle2 }).catch(() => {
                console.log('  networkidle2 not reached before deadline, capturing current state');
                metadata.networkidle2_timed_out = true;
            });
        } else {
            metadata.networkidle2_timed_out = true;
        }
        metadata.html_size_bytes.networkidle2 = serialize_to('networkidle2', domain_output_directory, await page.content());






        
        // [SERIALIZATION POINT 6] : networkidle0 (0 in flight), capped within the deadline
        const remaining_for_networkidle0 = network_idle_deadline_milliseconds - (Date.now() - idle_reference_timestamp);
        if(remaining_for_networkidle0 > 0){
            await page.waitForNetworkIdle({ concurrency: 0, timeout: remaining_for_networkidle0 }).catch(() => {
                console.log('  networkidle0 not reached before deadline, capturing current state');
                metadata.networkidle0_timed_out = true;
            });
        } else {
            metadata.networkidle0_timed_out = true;
        }
        metadata.html_size_bytes.networkidle0 = serialize_to('networkidle0', domain_output_directory, await page.content());

        metadata.success = true;

    } catch (error){
        metadata.failure_reason = error.message;
        console.warn(`  Failed: ${error.message}. Capturing exit-state HTML.`);

        if(main_document_response){
            metadata.http_status = main_document_response.status();
            metadata.http_error = main_document_response.status() >= 400;
        }

        try {
            const exit_html = await page.content();
            metadata.html_size_bytes.exit_state = serialize_to('exit_state', domain_output_directory, exit_html);
        } catch (capture_error){
            console.warn(`  Could not capture exit-state HTML: ${capture_error.message}`);
        }

    } finally {
        await page.close().catch(() => {});
    }

    fs.writeFileSync(
        path.join(domain_output_directory, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
    );

    return metadata;
}































async function main(){




    const domains_file = path.join(__dirname, 'crux_latest', 'current.csv');

    if(!fs.existsSync(domains_file)){
        console.error('crux_latest/current.csv not found');
        process.exit(1);
    }

    let domains = fs.readFileSync(domains_file, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && line !== 'origin,rank')
        .map(line => line.split(',')[0]);

    if(provided_limit){
        domains = domains.slice(0, provided_limit);
    }

    console.log(`Loaded ${domains.length} domains`);
    prepare_profile_directory();



    const remote_debugging_port = 9222;
    const brave_process = spawn(brave_executable_path, [
        `--user-data-dir=${profile_directory}`,
        `--remote-debugging-port=${remote_debugging_port}`,
        ...build_browser_args(),
    ], { stdio: 'ignore' });

    await wait_for_debugger(remote_debugging_port);
    const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${remote_debugging_port}`,
        defaultViewport: null
    });



    const close_extension_pages = async () => {
        for (const open_page of await browser.pages()){
            if(open_page.url().startsWith('chrome-extension://')){
                await open_page.close().catch(() => {});
            }
        }
    };
    browser.on('targetcreated', () => { setTimeout(close_extension_pages, 1500); });




    const results = { successful: [], failed: [] };
    const error_log = {};


    for (const domain of domains){
        const result = await crawl_domain(domain, browser);
        if(result.success){
            results.successful.push(result.domain);
        } else {
            results.failed.push({ domain: result.domain, error: result.failure_reason });
            error_log[result.domain] = String(result.failure_reason);
        }
    }

    await browser.close().catch(() => {});
    brave_process.kill();





    fs.writeFileSync(
        path.join(variation_directory, 'errors.json'),
        JSON.stringify(error_log, null, 2),
        'utf-8'
    );


    console.log(`Successfully crawled : ${results.successful.length} | Failed: ${results.failed.length}`);

    if(results.failed.length > 0){
        console.log('Failed domains:');
        for (const failure of results.failed){
            console.log(`  ${failure.domain}: ${failure.error}`);
        }
    }
}

main();