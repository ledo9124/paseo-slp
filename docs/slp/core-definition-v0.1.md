# SLP Core Definition v0.1
## Supervisor — Lead — Peer

---

# 1. SLP là gì?

SLP là một mô hình tổ chức và điều phối agent dựa trên ba vai trò:

- **Supervisor**
- **Lead**
- **Peer**

Mục tiêu chính của SLP không phải tạo ra càng nhiều agent càng tốt.

Mục tiêu là **phân tách attention, responsibility và authority** để một agent không phải đồng thời:

- trao đổi liên tục với Human;
- hiểu và giữ Human intent;
- giữ toàn bộ trạng thái project;
- điều phối agent khác;
- giải quyết mọi vấn đề kỹ thuật;
- tự review;
- tự xác nhận kết quả của chính mình;
- theo dõi continuity của cả hệ thống.

SLP trước hết là một:

> **role / attention / authority model**

không phải một workflow cố định.

Các kỹ thuật như:

- blind design;
- multi-lane;
- debate;
- reviewer;
- council;
- automatic supervision trigger;
- automatic mode selection;
- Lead handoff;
- context compaction;

có thể được xây dựng trên SLP, nhưng **không phải định nghĩa cốt lõi của SLP**.

SLP Core nên giữ đơn giản.

Một nguyên tắc hoặc pattern không nên trở thành runtime primitive chỉ vì nó hữu ích.

Nếu một behavior có thể được giải quyết đủ tốt bằng role prompt hoặc delegation convention, nó nên được giữ ở tầng đó cho đến khi có evidence rõ ràng rằng runtime cần enforce nó.

---

# 2. Nguyên lý trung tâm

SLP dựa trên ba sự phân tách chính:

```text
Human interaction
        ↓
   Supervisor

Project authority
        ↓
      Lead

Bounded technical work
        ↓
      Peer
```

Mỗi role giữ một loại attention khác nhau.

```text
Supervisor
    → Human / intent / continuity / governance / process attention

Lead
    → project / architecture / coordination / integration attention

Peer
    → bounded technical problem attention
```

Mục tiêu là tránh một agent duy nhất trở thành bottleneck vì phải giữ tất cả các loại attention cùng lúc.

SLP không cố loại bỏ mọi bottleneck.

Nó cố:

> **phân tách bottleneck theo domain để mỗi agent chỉ giữ loại attention mà role đó thực sự cần.**

---

# 3. Human

Human là authority cuối cùng của hệ thống.

Human quyết định:

- outcome thực sự muốn đạt;
- project nào cần thực hiện;
- constraint quan trọng;
- priority;
- external effect nào được phép;
- quyết định nào agent không được tự suy diễn;
- khi nào cần Human judgment;
- sử dụng Direct Mode hay Supervised Mode.

Human không cần trực tiếp quản lý Peer.

Trong Supervised Mode:

> **Human mặc định giao tiếp với Supervisor.**

---

# 4. Supervisor

## 4.1 Vai trò

Supervisor là agent đứng giữa Human và tầng project execution khi hệ thống chạy ở Supervised Mode.

```text
Human
  ↕
Supervisor
  ↕
Lead
  ↓
Peer
```

Supervisor là conversational front door của hệ thống.

Một Supervisor có thể nhận:

```text
User messages
Lead requests
runtime events
supervision signals
human decisions
system signals
```

Không cần tạo một Supervisor riêng cho conversation và một Supervisor riêng cho monitoring.

Đó vẫn là cùng một role.

---

# 4.2 Human communication

Supervisor chịu trách nhiệm:

- trao đổi với Human;
- hiểu yêu cầu;
- làm rõ intent khi cần;
- giữ conversation continuity;
- xác định project/task liên quan;
- nhận thay đổi yêu cầu;
- phân biệt material information với conversational noise.

Supervisor trả lời câu hỏi:

> **Human thực sự muốn đạt outcome gì?**

---

# 4.3 Intent resolution

Supervisor chuyển raw Human conversation thành material context phù hợp cho Lead.

Ví dụ:

```text
Human conversation
        ↓
Supervisor
        ↓
Objective
Constraints
Human decisions
Unknowns
Requested outcome
        ↓
Lead
```

Supervisor không nên tự biến Human problem thành một technical solution chưa được xác lập.

Ví dụ không tốt:

```text
Human:
Login chậm.

Supervisor:
Dùng Redis.

Lead hãy implement Redis.
```

Tốt hơn:

```text
Objective:
Investigate and improve login latency.

Constraint:
Preserve authentication semantics.
```

Việc xác định nguyên nhân, architecture và solution thuộc engineering domain của Lead và Peer.

---

# 4.4 Attention protection

Supervisor bảo vệ coordination attention của Lead khỏi raw Human conversation.

Thay vì:

```text
40 conversational turns
        ↓
Lead
```

Supervisor có thể truyền:

```text
4 material decisions
2 changed constraints
1 unresolved question
        ↓
Lead
```

Mục tiêu không phải tóm tắt mọi thứ.

Mục tiêu là:

> **Lead chỉ nhận phần conversation có ảnh hưởng đến project state hoặc decision.**

---

# 4.5 Process supervision

Supervisor có thể quan sát quá trình:

```text
Lead ↔ Peer
```

để nhận biết các dấu hiệu đáng chú ý như:

- repeated failure;
- unresolved disagreement;
- agent bị blocked;
- mất continuity;
- process đang loop;
- Lead đang vô tình ép Peer xác nhận một conclusion;
- task có nguy cơ đi lệch Human intent;
- vấn đề cần Human decision.

Supervisor không cần xử lý mọi event.

Supervisor cũng không cần hiểu hoặc can thiệp vào mọi technical detail.

Supervisor chỉ cần có đủ visibility để biết:

```text
project đang đi đâu
có gì bất thường
Human có cần biết hoặc quyết định gì không
```

---

# 4.6 Supervisor không phải Super-Lead

Supervisor không mặc định:

- thiết kế architecture;
- quyết định implementation;
- phân công Peer;
- viết product code;
- override technical decision;
- accept engineering result;
- quản lý mọi task của Lead.

Supervisor giữ:

```text
Human intent
conversation continuity
process visibility
attention flow
governance
```

Lead vẫn giữ engineering authority.

Nếu Supervisor bắt đầu đảm nhận:

```text
Human communication
+ project architecture
+ Peer coordination
+ technical review
+ engineering acceptance
```

thì SLP chỉ chuyển bottleneck từ Lead sang Supervisor.

Đó không phải mục tiêu của kiến trúc.

---

# 5. Lead

Lead là:

> **project authority agent**

Lead chịu trách nhiệm cho một project, workspace hoặc bounded project outcome.

Lead giữ:

- project objective;
- project state;
- technical direction;
- architecture;
- topology;
- dependencies;
- ownership;
- cross-scope decisions;
- Peer coordination;
- integration;
- engineering acceptance.

Có thể hiểu:

```text
Supervisor:
"Human muốn đạt cái gì?"

Lead:
"Project phải làm gì để đạt cái đó?"
```

---

# 5.1 Lead không chỉ là task router

Lead không phải agent chỉ nhận requirement rồi chia nhỏ thành task.

Lead có quyền:

- tự giải quyết tiny task;
- điều tra problem;
- hình thành hypothesis;
- quyết định có cần Peer không;
- chọn Peer phù hợp;
- quyết định technical direction;
- đóng search space khi đủ evidence;
- nhận counterevidence;
- reopen decision;
- accept hoặc reject engineering result.

Lead tồn tại để giữ:

> **project coherence**

chứ không chỉ để forward message.

---

# 5.2 Lead được phép suy nghĩ và hình thành hypothesis

SLP không yêu cầu Lead phải luôn giữ tư duy hoàn toàn trung tính.

Lead được phép:

```text
analyze
reason
form hypotheses
compare approaches
make technical decisions
prefer one solution
```

Neutral delegation không có nghĩa:

```text
Lead không được suy nghĩ
Lead không được có opinion
Lead không được có hypothesis
```

Mục tiêu chỉ là tránh việc một conclusion chưa được xác lập của Lead vô tình trở thành premise bắt buộc của Peer trong những assignment cần independent judgment.

---

# 5.3 Preserve independent judgment

Nguyên tắc:

> **Khi independence là mục tiêu của assignment, Lead không nên biến conclusion hiện tại của mình thành conclusion mà Peer được kỳ vọng phải xác nhận.**

Điều này đặc biệt quan trọng với:

- investigation;
- exploratory design;
- independent review;
- root-cause analysis;
- architecture comparison.

Ví dụ không tốt:

```text
Lead:

Redis locking là solution đúng.

Hãy kiểm tra xem nó có hoạt động không.
```

Peer đã bị đặt vào search space:

```text
solution = Redis locking
```

thay vì:

```text
problem = concurrent update inconsistency
```

Tốt hơn:

```text
Objective:
Determine the cause of concurrent update inconsistency.

Constraints:
A
B
C

Investigate viable approaches.

Return:
- evidence;
- trade-offs;
- recommended action.
```

---

# 5.4 Neutral delegation không áp dụng cho mọi assignment

SLP không yêu cầu mọi delegation đều phải mở và trung tính.

Cần phân biệt mục đích của assignment.

## Exploration

```text
Goal:
Discover what is true.
```

Nên giữ search space mở.

Ví dụ:

```text
Investigate why duplicate processing occurs.

Identify likely causes and supporting evidence.
```

---

## Independent Review

```text
Goal:
Challenge existing work.
```

Nên tránh framing kiểu:

```text
"Thiết kế này ổn rồi, tìm vài lỗi nhỏ."
```

Tốt hơn:

```text
Review this design independently.

Look for:
- incorrect assumptions;
- failure modes;
- hidden coupling;
- unnecessary complexity;
- stronger alternatives.

If the current direction is wrong, say so.
```

---

## Hypothesis Testing

Hypothesis có thể được truyền thẳng.

Ví dụ:

```text
Current hypothesis:
Listener cleanup may be causing the memory leak.

Test this hypothesis.

Try to falsify it.

Return evidence supporting or rejecting it.
```

Hypothesis testing không cần giả vờ rằng hypothesis không tồn tại.

Điều cần tránh là:

```text
Prove that listener cleanup is the cause.
```

---

## Execution

Khi Lead đã ra technical decision, không cần giữ assignment mở.

Ví dụ:

```text
Decision:
Use optimistic concurrency control.

Assignment:
Implement version-based conflict detection in module X.

Constraints:
...
```

Peer lúc này không được giao nhiệm vụ lựa chọn architecture.

Nó đang thực thi một direction đã được Lead quyết định.

Nếu mọi execution task đều bị biến lại thành exploration:

```text
Investigate all possible approaches...
```

thì project sẽ liên tục reopen các decision đã đóng và coordination cost sẽ tăng không cần thiết.

---

# 5.5 Information quality

Neutrality không có nghĩa là giấu context.

Lead nên truyền những thông tin cần thiết như:

```text
Facts
Observations
Constraints
Known evidence
Relevant history
Current decisions
```

Hypothesis cũng có thể được truyền khi hữu ích.

Nhưng nên tránh biến:

```text
Hypothesis
```

thành:

```text
Fact
```

Ví dụ:

```text
Observation:
DB query count increased 5x after deployment.

Current hypothesis:
An N+1 query regression may be involved.

Task:
Determine the actual cause.

Do not assume the current hypothesis is correct.
```

Mục tiêu là:

> **Peer có đủ context để không lặp lại công việc vô ích, nhưng vẫn còn epistemic freedom để kết luận khác Lead.**

---

# 5.6 Open → Investigate → Decide → Execute

Lead không nên giữ mọi technical question ở trạng thái open mãi.

Một project bình thường nên có progression:

```text
Open problem
    ↓
Investigate
    ↓
Evidence
    ↓
Decision
    ↓
Execute
```

Sau khi decision được đưa ra:

```text
Search space closes
```

cho đến khi xuất hiện counterevidence đủ mạnh.

Khi đó:

```text
Peer / evidence
      ↓
decision may be wrong
      ↓
Lead
      ↓
REOPEN
```

SLP bảo vệ independent reasoning nhưng vẫn cho phép project hội tụ.

---

# 6. Peer

Peer là:

> **independent bounded technical worker**

Peer không đồng nghĩa với implementer.

Một Peer có thể mang disposition như:

```text
Engineer
Architect
Reviewer
Scout
Researcher
Shadow
```

Nhưng tất cả vẫn thuộc cùng một role:

```text
Peer
```

---

# 6.1 Bounded assignment

Peer nhận một bounded assignment.

Assignment nên làm rõ đủ để Peer hiểu:

```text
Objective
Scope
Authority
Constraints
Expected evidence / artifact
Stop or handback condition
```

Đây là guideline cho delegation.

Không bắt buộc runtime phải encode mọi field thành protocol riêng.

Nếu prompt hoặc task message truyền đạt được đủ rõ thì đã đạt mục tiêu của Core.

Peer không cần giữ toàn bộ project state.

Nó chỉ cần đủ context để giải quyết assignment của mình.

---

# 6.2 Independent technical judgment

Peer phải có quyền hình thành đánh giá kỹ thuật riêng.

Peer không tồn tại để đồng ý với Lead.

Nếu evidence cho thấy premise hiện tại sai, Peer có thể nói:

```text
Current assumption appears incorrect.

Evidence:
...

I recommend reopening this decision.
```

Independent judgment không có nghĩa:

```text
Peer phải cố tình phản đối Lead.
```

```text
Independent judgment
≠ manufactured disagreement
```

Mục tiêu là truth-seeking, không phải tạo debate một cách nhân tạo.

---

# 6.3 Peer không orchestration

Peer không mặc định:

- spawn Peer khác;
- quản lý agent;
- thay Lead;
- tự mở rộng project scope;
- thay Human objective;
- accept engineering result;
- điều phối toàn project.

Peer thực hiện bounded work và handback:

```text
artifact
evidence
judgment
open questions
```

cho Lead.

---

# 7. Quan hệ Supervisor — Lead — Peer

SLP không nên được hiểu là hierarchy quyền lực đơn giản:

```text
Supervisor
   ↓
Lead
   ↓
Peer
```

theo nghĩa:

```text
Supervisor > Lead > Peer
```

Authority của các role thuộc các domain khác nhau.

```text
Human
  │
  ├── Human / product authority
  │
Supervisor
  │
  ├── conversation / intent / governance
  │
Lead
  │
  ├── project / engineering authority
  │
Peer
     └── bounded technical judgment
```

Supervisor không có technical authority cao hơn Lead chỉ vì tên là Supervisor.

Lead cũng không có quyền biến Peer thành một model chỉ để xác nhận conclusion của mình khi mục tiêu assignment cần independent judgment.

---

# 8. Hai topology cơ bản

## 8.1 Direct Mode

Không sử dụng Supervisor.

```text
Human
  ↕
Lead
  ↓
Peer(s)
```

Phù hợp với:

- task nhỏ;
- session ngắn;
- project đơn giản;
- ít Human interaction;
- không cần tách conversation attention khỏi project attention.

---

## 8.2 Supervised Mode

```text
Human
  ↕
Supervisor
  ↕
Lead
  ↓
Peer(s)
```

Phù hợp với:

- project dài;
- conversation kéo dài;
- nhiều thay đổi intent;
- nhiều task;
- nhiều project hoặc nhiều Lead;
- cần continuity;
- cần process supervision.

Trong mode này:

> **Human mặc định giao tiếp với Supervisor, không phải Lead.**

Nếu Lead cần Human decision:

```text
Lead
  ↓
Supervisor
  ↓
Human
  ↓
Supervisor
  ↓
Lead
```

Supervisor chỉ relay phần decision hoặc material context cần thiết.

---

# 9. Ai quyết định sử dụng Supervisor?

Trong SLP Core ban đầu:

> **Human quyết định.**

Không cần automatic mode classifier.

Ví dụ:

```text
mode = DIRECT
```

hoặc:

```text
mode = SUPERVISED
```

Sau này có thể bổ sung:

```text
mode = AUTO
```

nhưng đây không phải requirement của SLP Core.

Không nên đưa automatic classification vào phiên bản đầu chỉ vì nó có thể hữu ích về sau.

---

# 10. Smallest useful topology

SLP không có nghĩa lúc nào cũng phải có ba role đang active.

Nguyên tắc:

> **Dùng topology nhỏ nhất vẫn giữ được authority boundary và independent judgment cần thiết.**

Ví dụ:

## Tiny task

```text
Human
  ↓
Lead
```

## Material implementation

```text
Human
  ↓
Lead
  ↓
Peer Engineer
```

## Independent review

```text
Lead
  ↓
Peer Engineer
  ↓
stable candidate
  ↓
Peer Reviewer
```

## Long-running supervised project

```text
Human
  ↕
Supervisor
  ↕
Lead
  ↓
Peer(s)
```

Không spawn agent chỉ để tạo ceremony.

---

# 11. Blind design, multi-lane và debate

Các cơ chế sau không phải SLP Core:

- blind design;
- multi-lane;
- debate;
- council;
- automatic reviewer;
- shadow agent;
- automatic challenge lane.

Chúng là tactics để tăng independent reasoning khi risk đủ lớn.

Ví dụ blind design:

```text
             Lead
           /  |  \
      Peer A Peer B Peer C
         │      │      │
     independent solutions
             ↓
            Lead
         synthesis
```

Chỉ dùng khi nhiều independent perspective thực sự đáng giá.

Task bình thường hoàn toàn có thể chỉ cần:

```text
Lead → Peer
```

---

# 12. Acceptance boundary

Một nguyên tắc quan trọng:

```text
Peer completion
≠ engineering acceptance
```

Peer có thể báo:

```text
done
tests pass
candidate ready
```

nhưng đó vẫn chỉ là:

```text
handback + evidence
```

Lead giữ engineering acceptance trong project boundary.

```text
Peer
  ↓
artifact + evidence
  ↓
Lead
  ↓
ACCEPT
REOPEN
REJECT
UNKNOWN
```

Điều này tránh việc cùng một bounded worker:

```text
implement
+
judge its own work
+
declare project success
```

---

# 13. Attention decomposition

Không có SLP:

```text
One Agent
 ├─ Human conversation
 ├─ intent
 ├─ continuity
 ├─ project state
 ├─ architecture
 ├─ coding
 ├─ delegation
 ├─ review
 ├─ monitoring
 └─ acceptance
```

Agent này dễ trở thành bottleneck vì attention phải liên tục chuyển giữa các domain khác nhau.

Với SLP:

```text
Supervisor
 ├─ Human conversation
 ├─ intent
 ├─ process visibility
 └─ continuity

Lead
 ├─ project state
 ├─ architecture
 ├─ coordination
 ├─ integration
 └─ acceptance

Peer
 └─ bounded technical problem
```

Đây là giá trị kiến trúc cốt lõi của SLP.

---

# 14. Runtime boundary của SLP Core

SLP Core không nên cố enforce mọi reasoning principle trong runtime.

Runtime chỉ cần hỗ trợ đủ để các role có thể tồn tại và giao tiếp đúng boundary.

Ở mức tối thiểu, runtime cần cho phép:

```text
role/session separation
message routing
project/session association
context boundary cần thiết
authority boundary cần thiết
agent lifecycle cơ bản
```

Các behavior như:

```text
neutral delegation
independent critique
hypothesis falsification
avoid confirmation bias
open-ended exploration
```

trước hết thuộc:

```text
role prompt
delegation prompt
working convention
```

Không nên ngay lập tức biến chúng thành:

```text
runtime validator
neutrality scorer
framing detector
complex assignment schema
semantic classifier
```

Nếu về sau evidence thực tế cho thấy prompt không đủ đáng tin cậy đối với một behavior quan trọng, khi đó mới cân nhắc runtime support.

Nguyên tắc phát triển:

> **Start with prompts and simple boundaries. Promote behavior into runtime only when there is a demonstrated reason.**

---

# 15. Những gì chưa thuộc SLP Core

Các phần sau nên để phát triển dần:

- automatic mode selection;
- semantic drift detection;
- complex Supervisor scoring;
- complex trigger taxonomy;
- automatic blind design;
- automatic multi-lane orchestration;
- council;
- automatic reviewer spawning;
- Lead replacement;
- automatic context handoff;
- persistent Supervisor notebook;
- portfolio planning;
- dynamic topology adaptation;
- advanced state machine;
- framing detection;
- neutrality scoring;
- reasoning quality scoring.

Chúng có thể nâng cấp SLP.

Nhưng không nên trở thành dependency để implementation ban đầu hoạt động.

---

# 16. Các nguyên tắc reasoning quan trọng

SLP không cố làm cho model "không bị ảnh hưởng" bởi context.

Điều đó không thực tế.

Mục tiêu là:

> **truyền đủ context cần thiết nhưng tránh đóng search space sớm hơn mức cần thiết.**

Một cách hiểu đơn giản:

```text
Facts
+ observations
+ constraints
+ useful evidence
+ necessary context

nhưng

- premature conclusion
- forced agreement
- unnecessary solution framing
```

Đặc biệt đối với exploratory work:

```text
Early:
preserve search space

Middle:
reduce search space using evidence

Decision:
commit to a direction

Execution:
follow the direction

Counterevidence:
reopen deliberately
```

Hay:

```text
Open
  ↓
Investigate
  ↓
Decide
  ↓
Execute
  ↓
Reopen if necessary
```

---

# 17. Định nghĩa ngắn gọn

SLP có thể được định nghĩa như sau:

> **SLP là mô hình multi-agent phân tách Human interaction, project authority và bounded technical judgment thành Supervisor, Lead và Peer. Supervisor giữ Human intent, conversation continuity và process supervision; Lead giữ project coherence, technical decisions, coordination, integration và engineering acceptance; Peer thực hiện bounded technical work với independent judgment.**

Trong Supervised Mode:

> **Human giao tiếp với Supervisor để Lead không phải đồng thời giữ conversation attention và project coordination attention.**

Lead bảo vệ independent judgment của Peer khi independence thực sự là mục tiêu của assignment, nhưng được quyền đóng search space và đưa direction cụ thể sau khi technical decision đã được đưa ra.

SLP Core giữ runtime đơn giản.

Các nguyên tắc reasoning như neutral delegation trước hết được thực hiện bằng role prompt và delegation practice, không mặc định trở thành runtime mechanism.

Có thể tóm gọn ba role như sau:

```text
Supervisor
= protect Human intent and attention flow

Lead
= protect project coherence and decision continuity

Peer
= protect bounded independent technical judgment
```

Và triết lý vận hành:

```text
Use the smallest topology necessary.

Preserve independent judgment when it matters.

Close decisions when enough evidence exists.

Reopen only when meaningful counterevidence appears.

Do not move complexity into runtime without a real need.
```