"""Migrate prepare/*.md V1 command contracts to contract_version 2.1.

Rules:
- contract_version: 2.1 added
- consumes: ensure `required` boolean (default False)
- produces: ensure role (default attachment), required (first primary -> True,
  others keep existing or False), schema (<kind>/1.0 default)
- gates untouched (string gates are valid in V2)
"""
import io
import glob
import yaml

KEY_ORDER = ['name', 'description', 'argument-hint', 'session-mode', 'contract', 'refs']

def represent_str(dumper, data):
    if '\n' in data:
        return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
    return dumper.represent_scalar('tag:yaml.org,2002:str', data)

yaml.add_representer(str, represent_str)

def migrate_contract(contract):
    contract = dict(contract)
    contract['contract_version'] = 2.1
    consumes = []
    for item in contract.get('consumes', []):
        item = dict(item)
        item.setdefault('required', False)
        consumes.append(item)
    contract['consumes'] = consumes
    produces = []
    primary_seen = False
    for item in contract.get('produces', []):
        item = dict(item)
        role = item.get('role', 'attachment')
        item['role'] = role
        if role == 'primary' and not primary_seen:
            item['required'] = True
            primary_seen = True
        else:
            item.setdefault('required', False)
        item.setdefault('schema', f"{item['kind']}/1.0")
        produces.append(item)
    contract['produces'] = produces
    return contract

def ordered(data):
    keys = [k for k in KEY_ORDER if k in data] + [k for k in data if k not in KEY_ORDER]
    return {k: data[k] for k in keys}

for path in sorted(glob.glob('prepare/*.md')):
    text = io.open(path, encoding='utf-8').read()
    if not text.startswith('---'):
        print(f'SKIP no frontmatter: {path}')
        continue
    end = text.index('\n---', 3)
    fm_text = text[4:end]
    data = yaml.safe_load(fm_text)
    contract = data.get('contract')
    if not contract:
        print(f'SKIP no contract: {path}')
        continue
    if contract.get('contract_version') in (2, 2.1):
        print(f'SKIP already v2: {path}')
        continue
    data['contract'] = migrate_contract(contract)
    new_fm = yaml.dump(ordered(data), sort_keys=False, default_flow_style=False, allow_unicode=True, width=200)
    out = '---\n' + new_fm + '---' + text[end + 4:]
    io.open(path, 'w', encoding='utf-8', newline='').write(out)
    primaries = [p['path'] for p in data['contract']['produces'] if p['role'] == 'primary']
    print(f'OK {path} primaries={primaries}')
