"""Bounded, deadline-aware GitHub throttling; never weaken capture validity."""
import time
from email.utils import parsedate_to_datetime

class BudgetPolicy:
    def __init__(self, *, max_wait=90, deadline=None):
        self.max_wait=max_wait
        self.waited=0.0
        self.deadline=deadline
    def check_deadline(self, duration=0):
        if self.deadline is not None and time.time()+duration >= self.deadline:
            raise ValueError('采样有效窗口即将结束，停止请求；不补造快照')
    def wait(self, seconds):
        delay=max(1.0,float(seconds))
        if self.waited+delay > self.max_wait:
            raise ValueError('限流等待超过任务预算；需要稍后重试或配置更充足的采集令牌')
        self.check_deadline(delay)
        self.waited+=delay
        time.sleep(delay)
    def retry_delay(self, headers):
        retry=headers.get('Retry-After')
        if retry:
            try: return max(1,float(retry))
            except ValueError: return max(1,parsedate_to_datetime(retry).timestamp()-time.time()+1)
        reset=headers.get('X-RateLimit-Reset')
        if headers.get('X-RateLimit-Remaining')=='0' and reset:
            return max(1,float(reset)-time.time()+1)
        return 60
