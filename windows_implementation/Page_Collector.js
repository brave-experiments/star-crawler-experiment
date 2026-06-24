const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');


// override default UA provided by the stealth plugin
const stealth = stealth_plugin();
stealth.enabledEvasions.delete('user-agent-override');
puppeteer.use(stealth);

process.on('unhandledRejection', (reason) => { if(reason && reason.name === 'TargetCloseError') return; throw reason; });

const navigation_timeout_milliseconds = 45000;
const five_seconds_milliseconds = 5000;
const network_idle_deadline_milliseconds = 30000; // measured from the load event

const brave_executable_path = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';

const args = process.argv.slice(2);



// https://deviceatlas.com/blog/list-of-user-agent-strings


// mobile UA string : Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36
// tablet UA string : Mozilla/5.0 (Linux; Android 12; SM-X906C Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.119 Mobile Safari/537.36

/**
 * Changing the UA string and resolution might raise ambiguous questions about the nature of the device browsing
 * for example the UA string might indicate a mobile device but the OS characteristics a Windows 10 x86 machine
 * 
 * 
 * We could use: https://pptr.dev/api/puppeteer.page.emulate that would give us the apprpriate configurations 
 */




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


const domains_flag_index = args.indexOf('--domains');
const provided_domains_file = domains_flag_index !== -1 ? args[domains_flag_index + 1] : null;


// run index identifies WHICH of the synchronized visits this invocation performs (1..N). The
// orchestrator drives the visit loop across all instances and passes the run index per visit, so visit
// N happens at the same time on every box. Each visit is an independent person: its own fresh profile.
const run_index_flag_index = args.indexOf('--run-index');
const run_index = run_index_flag_index !== -1 ? parseInt(args[run_index_flag_index + 1], 10) : 1;

// delete this visit's profile after the crawl (off by default; profiles are kept for inspection). The
// HTML and metadata are always kept; only the (large) profile directory is removed when this is set.
const delete_profile_flag_index = args.indexOf('--delete-profile');
const delete_profile_after = delete_profile_flag_index !== -1;

// skip the region/country check (used for local testing without the VPN up)
const skip_region_flag_index = args.indexOf('--skip-region');
const skip_region_check = skip_region_flag_index !== -1;
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




const { region, profile_path, consent, resolution, device } = variation;
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







// =========================================================================================================================================================
// device emulation profiles for the mobile and tablet variations. Each profile is a coherent Chromium-engine identity (UA, client-hint metadata, legacy platform, touch, DPR) 
// so the browser presents as a real Android device rather than a desktop with a swapped UA string
// ----> Width and height come from the variation's resolution, not from here.
const chrome_brands = [
    { brand: 'Chromium', version: '144' },
    { brand: 'Google Chrome', version: '144' },
    { brand: 'Not?A_Brand', version: '24' }
];

function build_user_agent_metadata(platform, platform_version, model, mobile, architecture, bitness){
    return {
        brands: chrome_brands,
        fullVersionList: chrome_brands.map(brand => ({ brand: brand.brand, version: `${brand.version}.0.0.0` })),
        platform,
        platformVersion: platform_version,
        architecture,
        bitness,
        model,
        mobile,
        wow64: false
    };
}


// device emulated "profiles" for tablet and mobile devices
const device_profiles = {
    mobile: {
        user_agent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36',
        platform_string: 'Linux armv8l',
        max_touch_points: 5,
        device_scale_factor: 2.625,
        is_mobile: true,
        has_touch: true,
        ua_metadata: build_user_agent_metadata('Android', '13.0.0', 'Pixel 7', true, '', '')
    },
    tablet: {
        user_agent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        platform_string: 'Linux armv8l',
        max_touch_points: 5,
        device_scale_factor: 2,
        is_mobile: true,
        has_touch: true,
        ua_metadata: build_user_agent_metadata('Android', '13.0.0', 'SM-X700', false, '', '')
    }
};


/**
 * Apply a device profile to a fresh page. navigator.platform and maxTouchPoints are overridden on
 * every new document because setUserAgent metadata does not set them. The viewport carries the device 
 * DPR, mobile and touch flags at the variation's resolution, and the UA is set with client-hint metadata
 */
async function apply_device_profile(page, device_profile){
    await page.evaluateOnNewDocument((platform_string, max_touch_points) => {
        Object.defineProperty(navigator, 'platform', { get: () => platform_string });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => max_touch_points });
    }, device_profile.platform_string, device_profile.max_touch_points);

    await page.setViewport({
        width: viewport_width,
        height: viewport_height,
        deviceScaleFactor: device_profile.device_scale_factor,
        isMobile: device_profile.is_mobile,
        hasTouch: device_profile.has_touch
    });

    await page.setUserAgent(device_profile.user_agent, device_profile.ua_metadata);
}
// =========================================================================================================================================================

// ===================================================================================================================
// Network error categorisation: 
// Catch net::ERR_* string into a small set of causes so failures are analysable. 
// "blocked" is ERR_BLOCKED_BY_CLIENT, the uBlock signal for the content-filtering; "proxy" is ERR_TUNNEL_CONNECTION_FAILED, 
// the NordVPN exit failing to reach the host.
function categorize_network_error(error_text){
    if(!error_text) return null;
    const text = error_text.toUpperCase();
    if(text.includes('NAME_NOT_RESOLVED') || text.includes('NAME_RESOLUTION') || text.includes('DNS')) return 'dns';
    if(text.includes('CERT') || text.includes('SSL')) return 'tls';
    if(text.includes('TUNNEL_CONNECTION_FAILED') || text.includes('PROXY')) return 'proxy';
    if(text.includes('CONNECTION_REFUSED') || text.includes('CONNECTION_RESET') || text.includes('CONNECTION_CLOSED') || text.includes('CONNECTION_FAILED')) return 'connection';
    if(text.includes('TIMED_OUT') || text.includes('TIMEOUT')) return 'timeout';
    if(text.includes('BLOCKED_BY_CLIENT')) return 'blocked';
    if(text.includes('ABORTED')) return 'aborted';
    return 'other';
}





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
// profile is created fresh PER DOMAIN at websites/<domain>/profile and set inside the crawl loop
let profile_directory = null;
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
        // Windows has no cp; fs.cpSync recursively copies the seed profile and creates the dir
        fs.cpSync(seed_profile_path, profile_directory, { recursive: true });

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
    return value.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
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
        '--disable-crash-reporter',
        '--no-crashpad',
        '--hide-crash-restore-bubble',
        '--disable-session-crashed-bubble'
    ];

    // Consent-O-Matic (unless no-action) plus any --extension.
    const ublock_extension_path = path.join(__dirname, 'ublock-origin');
    const extension_paths = [];
    if(consent === 'content-filtering'){
        extension_paths.push(ublock_extension_path);
    } else if(consent !== 'no-action'){
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


function wait_for_port_free(port){
    return new Promise((resolve) => {
        const check = () => {
            const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
                response.resume();
                setTimeout(check, 300);
            });
            request.on('error', () => resolve());
        };
        check();
    });
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

// ===================================================================================================================
// IP veirification guard: in case we lose nordvpn connectivity terminate but keep index of termination so 
// we can continue from there
async function get_exit_ip(browser){
    const page = await browser.newPage();
    try {
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const body = await page.evaluate(() => document.body.innerText);
        return JSON.parse(body).ip;
    } catch (error){
        console.warn(`  Could not determine exit IP: ${error.message}`);
        return null;
    } finally {
        await page.close().catch(() => {});
    }
}


// ===================================================================================================================
// Browser lifecycle: this invocation performs ONE visit. It launches Brave on a freshly-seeded profile
// (an independent person), confirms the exit country (NordVPN can return a different in-region IP on each
// reconnect), crawls once, and tears the browser down fully.
const remote_debugging_port = 9222; // one Brave per box now, so a fixed port is fine
const region_to_country = { US: 'US', UK: 'GB', JP: 'JP' };

// before each launch, force the profile to open fresh: mark it as cleanly exited (so Brave does not
// enter crash-restore) and set restore-on-startup to the New Tab page (so previously open tabs, e.g.
// the crawl tab from the last run, are never reopened and do not accumulate across relaunches)
function force_fresh_session(){
    const preferences_path = path.join(profile_directory, 'Default', 'Preferences');
    if(!fs.existsSync(preferences_path)) return;
    try {
        const preferences = JSON.parse(fs.readFileSync(preferences_path, 'utf-8'));

        preferences.profile = preferences.profile || {};
        preferences.profile.exit_type = 'Normal';
        preferences.profile.exited_cleanly = true;

        preferences.session = preferences.session || {};
        preferences.session.restore_on_startup = 5; // 5 = open the New Tab page, not the previous session

        fs.writeFileSync(preferences_path, JSON.stringify(preferences), 'utf-8');
    } catch (error){}
}

// exit IP and country through the browser, so it traverses the NordVPN proxy
async function get_exit_info(browser){
    const page = await browser.newPage();
    try {
        await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const body = await page.evaluate(() => document.body.innerText);
        const parsed = JSON.parse(body);
        return { ip: parsed.ip || null, country: parsed.country || null };
    } catch (error){
        console.warn(`  Could not determine exit info: ${error.message}`);
        return { ip: null, country: null };
    } finally {
        await page.close().catch(() => {});
    }
}

// after a relaunch the NordVPN extension needs a moment to reconnect, so poll until the exit country
// matches the variation's region before crawling
async function wait_for_region(browser, expected_country, max_attempts){
    for (let attempt = 1; attempt <= max_attempts; attempt++){
        const info = await get_exit_info(browser);
        if(info.country === expected_country){
            return { ok: true, ip: info.ip, country: info.country };
        }
        console.log(`    waiting for ${expected_country} (attempt ${attempt}/${max_attempts}): exit ${info.ip} country ${info.country}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const info = await get_exit_info(browser);
    return { ok: false, ip: info.ip, country: info.country };
}

// a fresh Brave launch recreates the Singleton lock, so strip it before each relaunch
function strip_singleton_locks(){
    for (const lock_file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']){
        fs.rmSync(path.join(profile_directory, lock_file), { force: true });
    }
}

// spawn Brave on the shared profile and connect
async function launch_browser(){
    strip_singleton_locks();
    force_fresh_session();
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

    browser.on('targetcreated', () => { setTimeout(async () => {
        try {
            for (const open_page of await browser.pages()){
                let page_url = '';
                try { page_url = open_page.url(); } catch (error){ continue; }
                if(page_url.startsWith('chrome-extension://')){
                    await open_page.close().catch(() => {});
                }
            }
        } catch (error){}
    }, 1500); });

    return { browser, brave_process };
}

// close the browser FULLY before the next launch. browser.close() asks Brave to quit, but the spawned
// process can return before the browser is actually gone, so we also kill this worker's process tree by
// pid and only return once the debug port stops answering (the real signal the browser is gone). killing
// by pid (this worker's brave_process) never touches the other parallel workers' browsers.
async function close_browser(browser, brave_process){
    await browser.close().catch(() => {});

    try {
        require('child_process').execSync(`taskkill /pid ${brave_process.pid} /T /F`, { stdio: 'ignore' });
    } catch (error){}

    await wait_for_port_free(remote_debugging_port);

    // give Windows a moment to release the profile lock and socket before the next launch
    await new Promise((resolve) => setTimeout(resolve, 2000));
}









//Core crawl: one visit =========> 6 SERIALIZATION POINTS
async function crawl_domain(domain, browser, index, run_index){


    const url = domain.startsWith('http') ? domain : `https://${domain}`;
    const sanitized_domain = sanitize_for_filesystem(domain);
    const domain_output_directory = path.join(websites_directory, sanitized_domain, `run_${run_index}`);
    
    
    if(!fs.existsSync(domain_output_directory)){
        fs.mkdirSync(domain_output_directory, { recursive: true });
    }


    // metadata for each page/visited domain
    const metadata = {
        url,
        domain,
        timestamp: new Date().toISOString(),
        variation_id,
        run_index,
        region,
        consent,
        resolution: `${viewport_width}x${viewport_height}`,
        device: device || 'desktop',
        serialization_points,
        success: false,
        failure_reason: null,
        http_status: null,
        http_error: false,
        network_error: null,
        error_category: null,
        tls: null,
        user_agent: null,
        load_event_fired: false,
        networkidle2_timed_out: false,
        networkidle0_timed_out: false,
        dwell_time_milliseconds: null,
        failed_request_total: 0,
        failed_requests_by_error: {},
        failed_requests_by_category: {},
        error_response_count: 0,
        html_size_bytes: {}
    };

    
    
    
    console.log(`\nCrawling: [${index}] ---> ${domain}`);
    const page = await browser.newPage();


    const active_device_profile = device ? device_profiles[device] : null;
    if(active_device_profile){
        await apply_device_profile(page, active_device_profile);
    } else {
        await page.setViewport({ width: viewport_width, height: viewport_height });
    }
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com' });
    


    
    // lets see what UAs we get
    metadata.user_agent = await page.evaluate(() => navigator.userAgent).catch(() => null);

    // keep the FINAL main document response so status and raw server HTML survive even a later timeout
    let main_document_response = null;
    page.on('response', (response) => {
        if(response.status() >= 400){
            metadata.error_response_count += 1;
        }
        if(response.request().isNavigationRequest() &&
            response.frame() === page.mainFrame() &&
            response.request().resourceType() === 'document'){
            main_document_response = response;
        }
    });

    // tally every failed request by error and by category. ERR_BLOCKED_BY_CLIENT here is the uBlock signal
    let main_navigation_error = null;
    page.on('requestfailed', (request) => {
        const error_text = request.failure() ? request.failure().errorText : 'unknown';
        metadata.failed_request_total += 1;
        metadata.failed_requests_by_error[error_text] = (metadata.failed_requests_by_error[error_text] || 0) + 1;
        const error_category = categorize_network_error(error_text);
        metadata.failed_requests_by_category[error_category] = (metadata.failed_requests_by_category[error_category] || 0) + 1;
        if(request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            request.resourceType() === 'document'){
            main_navigation_error = error_text;
        }
    });

    // load fires after domcontentloaded ----------->  wait on it and record whether it fired
    let load_event_fired = false;
    const load_event_promise = new Promise((resolve) => page.once('load', () => { load_event_fired = true; resolve(); }));



    let navigation_start_timestamp = null;
    try {
        //dwell time on page 
        navigation_start_timestamp = Date.now();
        // return at domcontentloaded so a slow load cannot block the later captures
        console.log(`  Navigating to ${url}...`);
        const navigation_response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigation_timeout_milliseconds });

        const status_response = navigation_response || main_document_response;
        if(status_response){
            metadata.http_status = status_response.status();
            metadata.http_error = status_response.status() >= 400;

            const security_details = status_response.securityDetails();
            if(security_details){
                metadata.tls = {
                    protocol: security_details.protocol(),
                    issuer: security_details.issuer(),
                    subject_name: security_details.subjectName(),
                    valid_from: security_details.validFrom(),
                    valid_to: security_details.validTo()
                };
            }

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
        metadata.network_error = main_navigation_error || error.message;
        metadata.error_category = categorize_network_error(metadata.network_error);
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
        
        if(navigation_start_timestamp !== null){
            metadata.dwell_time_milliseconds = Date.now() - navigation_start_timestamp;
        }

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




    const domains_file = provided_domains_file
        ? path.join(__dirname, provided_domains_file)
        : path.join(__dirname, 'crux_latest', 'current.csv');

    if(!fs.existsSync(domains_file)){
        console.error(`${domains_file} not found`);
        process.exit(1);
    }

    let domains = fs.readFileSync(domains_file, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && line !== 'origin,rank')
        .map(line => line.split(',')[0]);

    const url_flag_index = args.indexOf('--url');
    if(url_flag_index !== -1 && args[url_flag_index + 1]){
        domains = [args[url_flag_index + 1]];
    }

    if(provided_limit){
        domains = domains.slice(0, provided_limit);
    }


    console.log(`Loaded ${domains.length} domains`);
    console.log(`Run index ${run_index} | debug port ${remote_debugging_port}`);

    // ONE visit per invocation. The orchestrator drives the visit loop (1..N) across all instances and
    // invokes this once per visit, so visit N happens at the same time on every box. This process performs
    // exactly run_index's visit of the single target domain.
    const expected_country = region_to_country[region] || region;

    // one domain per invocation in the synchronized design (the orchestrator feeds a single URL at a time)
    const domain = domains[0];
    const index = 0;
    const error_log = [];
    let succeeded = false;

    // fresh, independent profile for THIS visit (a distinct "person"): seeded from the pristine region
    // seed, never reused across visits, so no cookies/storage carry over between the 10 visits.
    const sanitized_domain = sanitize_for_filesystem(domain);
    profile_directory = path.join(websites_directory, sanitized_domain, `run_${run_index}`, 'profile');
    prepare_profile_directory();

    console.log(`\n=== ${domain} | visit ${run_index} ===`);

    const { browser, brave_process } = await launch_browser();

    let region_status;
    if(skip_region_check){
        const info = await get_exit_info(browser);
        region_status = { ok: true, ip: info.ip, country: info.country };
        console.log(`  exit ${region_status.ip} (${region_status.country}) [region check skipped]`);
    } else {
        region_status = await wait_for_region(browser, expected_country, 10);
        console.log(`  exit ${region_status.ip} (${region_status.country}) ${region_status.ok ? 'in region' : 'REGION MISMATCH'}`);
    }

    if(region_status.ok){
        const result = await crawl_domain(domain, browser, index, run_index);
        succeeded = result.success;
        if(!result.success){
            error_log.push({ run_index, domain: result.domain, error: String(result.failure_reason) });
        }
    } else {
        console.warn(`  Region not confirmed, skipping crawl for visit ${run_index}`);
        error_log.push({ run_index, domain, error: 'region not confirmed' });
    }

    await close_browser(browser, brave_process);

    // optionally discard this visit's (large) profile, keeping the HTML + metadata
    if(delete_profile_after){
        fs.rmSync(profile_directory, { recursive: true, force: true });
        console.log(`  profile for visit ${run_index} deleted`);
    }

    if(error_log.length > 0){
        fs.writeFileSync(
            path.join(websites_directory, sanitized_domain, `run_${run_index}`, 'error.json'),
            JSON.stringify(error_log, null, 2),
            'utf-8'
        );
    }
}

main();