const NICHES = {
  saas:{
    title:'SaaS Lead Qualification Demo',
    subtitle:'See how AI qualifies a SaaS buyer in real time',
    label:'Biggest SaaS challenge',
    options:['High churn rate','Low trial-to-paid conversion','Slow lead follow-up','Manual onboarding process','Poor activation rates'],
    placeholder:'e.g. We have 200 trial signups/month but only 8% convert to paid. We need to automate our nurture sequence urgently.'
  },
  realestate:{
    title:'Real Estate Lead Qualification Demo',
    subtitle:'See how AI qualifies a property buyer or investor',
    label:'What are you looking for',
    options:['Buying commercial property','Selling a portfolio','Property investment advice','Development financing','Real estate fund'],
    placeholder:'e.g. Looking to acquire 3-5 commercial properties in the $2M-$5M range within the next 6 months.'
  },
  finance:{
    title:'Finance Lead Qualification Demo',
    subtitle:'See how AI qualifies a financial services lead',
    label:'Financial service needed',
    options:['Business loan or funding','Investment management','CFO advisory','Tax optimization','M&A support'],
    placeholder:'e.g. Our Series A startup needs help structuring finances and preparing for our next funding round.'
  },
  ecommerce:{
    title:'E-commerce Lead Qualification Demo',
    subtitle:'See how AI qualifies an e-commerce business',
    label:'Biggest challenge',
    options:['Low conversion rate','High cart abandonment','Customer retention','Ads not profitable','Inventory management'],
    placeholder:'e.g. We do $500k/month revenue but ROAS dropped from 4x to 1.8x. Losing money on ads and need help urgently.'
  },
  agency:{
    title:'Agency Lead Qualification Demo',
    subtitle:'See how AI qualifies an agency client',
    label:'Service needed',
    options:['Lead generation system','Marketing automation','Sales funnel build','AI integration','Full agency retainer'],
    placeholder:'e.g. 50-person consulting firm. Need to automate our entire outbound lead gen process to scale without hiring.'
  }
};

let currentNiche = null;

function selectNiche(niche) {
  currentNiche = niche;
  document.querySelectorAll('.niche-card').forEach(c => c.classList.remove('active'));
  document.getElementById('niche-' + niche).classList.add('active');
  const cfg = NICHES[niche];
  document.getElementById('formTitle').textContent = cfg.title;
  document.getElementById('formSubtitle').textContent = cfg.subtitle;
  document.getElementById('nicheLabel').textContent = cfg.label;
  document.getElementById('message').placeholder = cfg.placeholder;
  const sel = document.getElementById('nicheQuestion');
  sel.innerHTML = '<option value="">Select one</option>';
  cfg.options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  });
  document.getElementById('formContainer').classList.add('visible');
  document.getElementById('resultCard').classList.remove('visible');
  document.getElementById('loadingState').classList.remove('visible');
  setTimeout(() => {
    document.getElementById('formContainer').scrollIntoView({behavior:'smooth',block:'start'});
  }, 100);
}

async function submitLead(e) {
  e.preventDefault();
  const nicheQ = document.getElementById('nicheQuestion').value;
  const msg = document.getElementById('message').value;
  const lead = {
    first_name: document.getElementById('firstName').value,
    last_name: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    phone: document.getElementById('phone').value,
    company: document.getElementById('company').value,
    job_title: document.getElementById('jobTitle').value,
    company_size: document.getElementById('companySize').value,
    budget: document.getElementById('budget').value,
    website: document.getElementById('website').value,
    industry: currentNiche,
    message: nicheQ ? nicheQ + '. ' + msg : msg,
    _source: 'demo-page'
  };
  document.getElementById('formContainer').classList.remove('visible');
  document.getElementById('loadingState').classList.add('visible');
  document.getElementById('loadingState').scrollIntoView({behavior:'smooth'});
  await animateSteps();
  const result = qualify(lead);
  showResult(lead, result);
}

async function animateSteps() {
  const ids = ['step1','step2','step3','step4'];
  for (let i = 0; i < ids.length; i++) {
    await sleep(650);
    if (i > 0) {
      const prev = document.getElementById(ids[i-1]);
      prev.classList.remove('active');
      prev.classList.add('done');
      prev.innerHTML = '<span style="color:#10b981">✓</span> ' + prev.textContent.trim();
    }
    document.getElementById(ids[i]).classList.add('active');
  }
  await sleep(650);
  const last = document.getElementById(ids[3]);
  last.classList.remove('active');
  last.classList.add('done');
  last.innerHTML = '<span style="color:#10b981">✓</span> ' + last.textContent.trim();
}

function qualify(lead) {
  let score = 35;
  const pain = [];
  const signals = [];
  const title = (lead.job_title || '').toLowerCase();
  if (/ceo|coo|cto|founder|owner|president/.test(title)) { score += 25; signals.push('C-suite decision maker'); }
  else if (/vp|vice president|director|head of/.test(title)) { score += 18; signals.push('Senior leadership'); }
  else if (/manager|lead|senior/.test(title)) { score += 10; signals.push('Mid-level manager'); }
  else { score += 4; }
  const size = lead.company_size || '';
  if (size.includes('500+')) { score += 18; signals.push('Enterprise company'); }
  else if (size.includes('201')) { score += 14; signals.push('Mid-market company'); }
  else if (size.includes('51')) { score += 9; signals.push('Growing SMB'); }
  else if (size.includes('11')) { score += 5; }
  const budget = lead.budget || '';
  if (budget.includes('25,000')) { score += 18; signals.push('High budget $25k+'); }
  else if (budget.includes('10,000')) { score += 13; signals.push('Strong budget $10k+'); }
  else if (budget.includes('5,000')) { score += 9; signals.push('Moderate budget'); }
  else if (budget.includes('1,000')) { score += 4; }
  const msg = (lead.message || '').toLowerCase();
  if (/manual|manually/.test(msg)) pain.push('Manual processes blocking growth');
  if (/churn|losing customer/.test(msg)) pain.push('Customer churn problem');
  if (/convert|conversion/.test(msg)) pain.push('Low conversion rate');
  if (/automat/.test(msg)) pain.push('Needs automation solution');
  if (/revenue|sales|deal/.test(msg)) pain.push('Revenue growth challenge');
  if (/follow.up|followup/.test(msg)) pain.push('Slow follow-up process');
  if (/scale|scaling/.test(msg)) pain.push('Scaling bottleneck');
  if (/urgent|asap|immediately|this month|this quarter/.test(msg)) { pain.push('High urgency'); score += 8; }
  score += Math.min(pain.length * 3, 10);
  const domain = (lead.email.split('@')[1] || '').toLowerCase();
  const free = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com'];
  if (!free.includes(domain)) { score += 5; signals.push('Company email domain'); }
  else { score -= 10; }
  score = Math.min(97, Math.max(10, score));
  if (pain.length === 0) pain.push('Business growth objectives', 'Operational efficiency');
  if (signals.length === 0) signals.push('Inbound inquiry');
  let tier, reasoning;
  if (score >= 80) { tier = 'hot'; reasoning = 'Strong ICP match — ' + signals[0] + (budget ? ', clear budget signal' : '') + '. Immediate full outreach triggered.'; }
  else if (score >= 50) { tier = 'warm'; reasoning = 'Good potential but missing some signals. Personalized nurture email triggered.'; }
  else { tier = 'cold'; reasoning = 'Insufficient signals. Added to long-term nurture — no immediate outreach.'; }
  return { score, tier, reasoning, pain, signals };
}

function showResult(lead, result) {
  document.getElementById('loadingState').classList.remove('visible');
  const card = document.getElementById('resultCard');
  card.className = 'result-card visible result-' + result.tier;
  const labels = { hot:'🔥 Hot Lead', warm:'🟡 Warm Lead', cold:'❄️ Cold Lead' };
  document.getElementById('tierBadge').textContent = labels[result.tier];
  document.getElementById('resultName').textContent = lead.first_name + ' ' + lead.last_name;
  document.getElementById('resultCompany').textContent = (lead.job_title || 'Professional') + ' at ' + lead.company;
  document.getElementById('scoreNum').textContent = result.score;
  document.getElementById('scoreReason').textContent = result.reasoning;
  setTimeout(() => {
    document.getElementById('ringFill').style.strokeDashoffset = 220 - (result.score / 100) * 220;
  }, 100);
  const painTags = document.getElementById('painTags');
  painTags.innerHTML = '';
  result.pain.forEach(p => { const t = document.createElement('div'); t.className = 'tag'; t.textContent = p; painTags.appendChild(t); });
  const sigTags = document.getElementById('signalTags');
  sigTags.innerHTML = '';
  result.signals.forEach(s => { const t = document.createElement('div'); t.className = 'tag'; t.textContent = s; sigTags.appendChild(t); });
  const actions = {
    hot: ['Lead scored ' + result.score + '/100 — classified as HOT','Personalized email drafted by GPT-4o sent to ' + lead.email,'AI voice call scheduled via Vapi in 15 minutes','Contact created in CRM — stage: Outreach Sent','Calendar slot reserved for discovery call'],
    warm: ['Lead scored ' + result.score + '/100 — classified as WARM','Nurture email drafted by GPT-4o sent to ' + lead.email,'Follow-up task created in CRM for 48 hours','Added to warm nurture sequence'],
    cold: ['Lead scored ' + result.score + '/100 — classified as COLD','Added to long-term nurture sequence','No immediate email — protecting domain reputation','Re-qualification scheduled in 30 days']
  };
  const al = document.getElementById('actionsList');
  al.innerHTML = '';
  actions[result.tier].forEach(a => { al.innerHTML += '<div class="action-item"><div class="action-check">✓</div>' + a + '</div>'; });
  const notes = {
    hot: 'In production: A personalized email referencing "' + result.pain[0] + '" was sent to ' + lead.email + ' within 60 seconds. An AI voice call is now scheduled.',
    warm: 'In production: A helpful nurture email was sent to ' + lead.email + ' with insights about ' + result.pain[0] + '. Follow-up in 48 hours.',
    cold: 'In production: ' + lead.first_name + ' is added to a long-term nurture sequence. No immediate outreach to protect sender reputation.'
  };
  document.getElementById('demoNote').textContent = '💡 ' + notes[result.tier];
  card.scrollIntoView({behavior:'smooth',block:'start'});
}

function resetForm() {
  document.getElementById('leadForm').reset();
  document.getElementById('resultCard').classList.remove('visible');
  document.getElementById('formContainer').classList.add('visible');
  const texts = {step1:'Validating lead data',step2:'Scoring ICP fit (0–100)',step3:'Detecting pain points',step4:'Determining action'};
  ['step1','step2','step3','step4'].forEach(id => {
    const el = document.getElementById(id);
    el.className = '';
    el.innerHTML = '<span class="step-dot"></span> ' + texts[id];
  });
  document.getElementById('formContainer').scrollIntoView({behavior:'smooth'});
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
