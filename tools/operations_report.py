"""Small, source-dated business health summary for the independent monitor."""
import argparse
import json
from pathlib import Path
from tools.star_rank import atomic_write_json
from tools.validate_star_rank_data import validate_data_tree


def write_report(root):
    validate_data_tree(root)
    def read(path):
        file=root/path
        return json.loads(file.read_text()) if file.exists() else None
    index=read('public/index.json')
    report={'version':1,'snapshot_at':index['updated_at'],'ranking_date':index['latest_date'],
            'observed_count':index['candidate_count'],'sampling':index.get('sampling'),'enrichment':{}}
    for kind,path in [('translation','public/i18n/zh-CN/repositories.json'),('classification','public/classification/index.json')]:
        value=read(path)
        report['enrichment'][kind]={'generated_at':value['generated_at'],'coverage':value['coverage']} if value else None
    runs=read('public/enrichment-runs/latest.json')
    if runs is not None:
        report['enrichment_runs']=runs['runs']
    atomic_write_json(root/'public/operations.json',report)
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path,required=True)
    print(json.dumps(write_report(parser.parse_args().data_dir),ensure_ascii=False))
