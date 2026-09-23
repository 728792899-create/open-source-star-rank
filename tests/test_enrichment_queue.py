from pathlib import Path
import tempfile
import unittest
from tools.enrichment_state import RetryQueue

class QueueTests(unittest.TestCase):
    def test_failed_batch_backs_off_and_rotates_behind_untouched_projects(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);pending=[{'repository_id':i} for i in range(1,5)]
            queue=RetryQueue(root,'classification','2026-09-21T01:00:00Z')
            self.assertEqual(queue.select(pending,2),pending[:2])
            queue.save({1,2,3,4},{1,2},{1,2})
            retry=RetryQueue(root,'classification','2026-09-21T01:01:00Z')
            self.assertEqual(retry.select(pending,4),pending[2:])
            later=RetryQueue(root,'classification','2026-09-22T01:00:00Z')
            self.assertEqual(later.select(pending,2),pending[2:])
            later.save({1,2},{3,4},set())
            self.assertEqual(set(later.items),{'1','2'})
    def test_backoff_is_capped_and_offline_read_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            queue=RetryQueue(root,'localization','2026-09-21T01:00:00Z')
            queue.select([{'repository_id':1}],10)
            self.assertFalse(queue.path.exists())
            for _ in range(12):queue.save({1},{1},{1})
            self.assertEqual(queue.items['1']['retry_at']-queue.now,86400)
    def test_source_change_bypasses_stale_failure_backoff(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);pending=[{'repository_id':1}]
            queue=RetryQueue(root,'localization','2026-09-21T01:00:00Z',fingerprints={1:'old'})
            queue.save({1},{1},{1})
            revised=RetryQueue(root,'localization','2026-09-21T01:00:00Z',fingerprints={1:'new'})
            self.assertEqual(revised.select(pending,1),pending)
    def test_service_outage_stops_batches_and_only_marks_attempted_projects(self):
        import datetime as dt
        import json
        from tools.localize_repositories import localize_repositories, ModelUnavailable
        from tools.classify_repositories import classify_repositories, ClassificationModelUnavailable
        class Client:
            def __init__(self): self.calls=[]
            def translate(self,rows):self.calls.append(rows[0]['repository_id']);raise ModelUnavailable('offline')
            def classify(self,rows):self.calls.append(rows[0]['repository_id']);raise ClassificationModelUnavailable('offline')
        for kind in ['localization','classification']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);daily=root/'public/daily/2026-09-19.json';daily.parent.mkdir(parents=True)
                daily.write_text(json.dumps({'date':'2026-09-19','entries':[{'repository_id':i,'full_name':f'owner/repo-{i}','description':None,'language':'Python'} for i in [1,2,3]]}))
                client=Client();params=dict(client=client,now=dt.datetime(2026,9,21,tzinfo=dt.timezone.utc),max_batch_size=1,max_projects=3)
                if kind=='localization':result=localize_repositories(root,**params)
                else:result=classify_repositories(root,taxonomy_file=Path('data/classification-taxonomy.zh-CN.json'),**params)[0]
                self.assertEqual(client.calls,[1]);self.assertEqual(result['failed_repository_ids'],[1]);self.assertEqual(result['coverage']['pending_count'],3)
    def test_public_only_never_writes_or_modifies_retry_queue(self):
        import datetime as dt
        import json
        from tools.localize_repositories import localize_repositories,ModelUnavailable
        from tools.classify_repositories import classify_repositories,ClassificationModelUnavailable
        class Client:
            def translate(self,rows):raise ModelUnavailable('offline')
            def classify(self,rows):raise ClassificationModelUnavailable('offline')
        for kind in ['localization','classification']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);daily=root/'public/daily/2026-09-19.json';daily.parent.mkdir(parents=True)
                daily.write_text(json.dumps({'date':'2026-09-19','entries':[{'repository_id':1,'full_name':'owner/project','description':None,'language':'Python'}]}))
                params=dict(client=Client(),now=dt.datetime(2026,9,21,tzinfo=dt.timezone.utc),write_state=False)
                run=lambda:localize_repositories(root,**params) if kind=='localization' else classify_repositories(root,taxonomy_file=Path('data/classification-taxonomy.zh-CN.json'),**params)
                run();self.assertFalse((root/'state').exists())
                queue=RetryQueue(root,kind,'2026-09-21T00:00:00Z');queue.save({1},{1},{1});before=queue.path.read_bytes()
                run();self.assertEqual(queue.path.read_bytes(),before)
