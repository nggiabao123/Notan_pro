/**
 * Notan Pro Core Engine (Chuẩn Thông tư 22/2021/TT-BGDĐT)
 * Xử lý dữ liệu điểm số, tính toán điểm mục tiêu, xếp loại học lực,
 * lưu trữ LocalStorage, sao lưu Base64 + DJB2 Checksum và âm thanh Web Audio API.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'notan_pro_data_v1';
  const MAX_TX_COLUMNS = 8;
  const MIN_TX_COLUMNS = 1;

  /**
   * Danh sách 8 môn học mặc định theo chương trình GDPT 2018
   */
  const DEFAULT_SUBJECT_CONFIGS = [
    { id: 'toan', name: 'Toán', txCount: 4 },
    { id: 'ngu_van', name: 'Ngữ văn', txCount: 4 },
    { id: 'tieng_anh', name: 'Tiếng Anh', txCount: 4 },
    { id: 'vat_li', name: 'Vật lí', txCount: 3 },
    { id: 'hoa_hoc', name: 'Hóa học', txCount: 3 },
    { id: 'tin_hoc', name: 'Tin học', txCount: 3 },
    { id: 'lich_su', name: 'Lịch sử', txCount: 3 },
    { id: 'dia_li', name: 'Địa lí', txCount: 3 }
  ];

  class GradeEngineClass {
    constructor() {
      this._audioCtx = null;
      this.state = this._loadFromStorage();
    }

    // =========================================================================
    // 1. KHỞI TẠO & QUẢN LÝ DỮ LIỆU (STATE & STORAGE)
    // =========================================================================

    /**
     * Tạo object môn học chuẩn (hỗ trợ tối đa 8 cột TX và đồng bộ locks + lockedValues)
     * @param {string} id
     * @param {string} name
     * @param {number} txCount - Số cột điểm thường xuyên (mặc định 3 hoặc 4, tối đa 8)
     * @returns {Object}
     */
    createSubject(id, name, txCount = 3) {
      const count = Math.max(MIN_TX_COLUMNS, Math.min(MAX_TX_COLUMNS, Number(txCount) || 3));
      const lockState = {
        tx: Array(count).fill(false),
        gk: false,
        ck: false
      };
      return {
        id: String(id),
        name: String(name),
        tx: Array(count).fill(null),
        gk: null,
        ck: null,
        target: null,
        locks: lockState,
        locked: {
          tx: [...lockState.tx],
          gk: false,
          ck: false
        },
        lockedValues: {
          tx: Array(count).fill(null),
          gk: null,
          ck: null
        }
      };
    }

    /**
     * Khởi tạo danh sách 8 môn học mặc định
     * @returns {Array<Object>}
     */
    createDefaultSubjects() {
      return DEFAULT_SUBJECT_CONFIGS.map((cfg) =>
        this.createSubject(cfg.id, cfg.name, cfg.txCount)
      );
    }

    /**
     * Đọc state từ localStorage, tự động khởi tạo mặc định nếu chưa có hoặc dữ liệu lỗi
     * @returns {{ subjects: Array<Object>, updatedAt: number }}
     */
    _loadFromStorage() {
      try {
        const raw = global.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          const initial = {
            subjects: this.createDefaultSubjects(),
            updatedAt: Date.now()
          };
          this._saveToStorage(initial);
          return initial;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.subjects) || parsed.subjects.length === 0) {
          throw new Error('Cấu trúc dữ liệu lưu trữ không hợp lệ.');
        }
        parsed.subjects = parsed.subjects.map((sub) => this._normalizeSubject(sub));
        return parsed;
      } catch (err) {
        const fallback = {
          subjects: this.createDefaultSubjects(),
          updatedAt: Date.now()
        };
        this._saveToStorage(fallback);
        return fallback;
      }
    }

    /**
     * Chuẩn hóa cấu trúc 1 môn học để đảm bảo an toàn kiểu dữ liệu
     * Đồng bộ hai chiều giữa `locks` và `locked`, đồng thời bảo toàn `lockedValues`
     * @param {Object} sub
     * @returns {Object}
     */
    _normalizeSubject(sub) {
      if (!sub || typeof sub !== 'object') {
        return this.createSubject('sub_' + Date.now(), 'Môn học', 3);
      }

      const rawTx = Array.isArray(sub.tx) && sub.tx.length > 0 ? sub.tx.slice(0, MAX_TX_COLUMNS) : [null, null, null];
      const txArr = rawTx.map((v) => this._sanitizeScore(v));

      const rawLockObj = sub.locks || sub.locked || {};
      const lockedTx = txArr.map((_, idx) =>
        Boolean(Array.isArray(rawLockObj.tx) ? rawLockObj.tx[idx] : false)
      );
      const lockedGk = Boolean(rawLockObj.gk);
      const lockedCk = Boolean(rawLockObj.ck);

      const rawLockedVals = sub.lockedValues || {};
      const lockedValTx = txArr.map((_, idx) =>
        Array.isArray(rawLockedVals.tx) ? this._sanitizeScore(rawLockedVals.tx[idx]) : null
      );
      const lockedValGk = this._sanitizeScore(rawLockedVals.gk);
      const lockedValCk = this._sanitizeScore(rawLockedVals.ck);

      const locksData = {
        tx: lockedTx,
        gk: lockedGk,
        ck: lockedCk
      };

      return {
        id: String(sub.id || 'sub_' + Date.now()),
        name: String(sub.name || 'Môn học'),
        tx: txArr,
        gk: this._sanitizeScore(sub.gk),
        ck: this._sanitizeScore(sub.ck),
        target: this._sanitizeScore(sub.target),
        locks: locksData,
        locked: {
          tx: [...lockedTx],
          gk: lockedGk,
          ck: lockedCk
        },
        lockedValues: {
          tx: lockedValTx,
          gk: lockedValGk,
          ck: lockedValCk
        }
      };
    }

    /**
     * Kiểm tra điểm hợp lệ trong [0, 10] hoặc trả về null
     * @param {*} val
     * @returns {number|null}
     */
    _sanitizeScore(val) {
      if (val === null || val === undefined || val === '') return null;
      const num = Number(val);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0 || num > 10) {
        return null;
      }
      return Math.round(num * 100) / 100;
    }

    /**
     * Lưu state hiện tại vào localStorage
     * @param {Object} [customState]
     */
    _saveToStorage(customState) {
      const targetState = customState || this.state;
      targetState.updatedAt = Date.now();
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(targetState));
      } catch (err) {
        console.error('[GradeEngine] Không thể lưu vào localStorage:', err);
      }
    }

    /**
     * Lấy toàn bộ danh sách môn học hiện tại
     * @returns {Array<Object>}
     */
    getSubjects() {
      return this.state.subjects;
    }

    /**
     * Lưu toàn bộ danh sách môn học mới vào state và localStorage
     * @param {Array<Object>} subjects
     * @returns {Array<Object>}
     */
    saveSubjects(subjects) {
      if (!Array.isArray(subjects)) return this.state.subjects;
      this.state.subjects = subjects.map((sub) => this._normalizeSubject(sub));
      this._saveToStorage();
      return this.state.subjects;
    }

    /**
     * Lấy thông tin 1 môn học theo ID
     * @param {string} subjectId
     * @returns {Object|null}
     */
    getSubjectById(subjectId) {
      return this.state.subjects.find((s) => String(s.id) === String(subjectId)) || null;
    }

    /**
     * Cập nhật điểm của một ô bất kỳ ('tx', 'gk', 'ck') và tự động lưu
     * @param {string} subjectId
     * @param {'tx'|'gk'|'ck'} type
     * @param {number|null} value
     * @param {number} [txIndex=0]
     * @returns {Object|null}
     */
    updateScore(subjectId, type, value, txIndex = 0) {
      const subject = this.getSubjectById(subjectId);
      if (!subject) return null;

      const cleanScore = this._sanitizeScore(value);

      if (type === 'tx') {
        if (txIndex >= 0 && txIndex < subject.tx.length) {
          subject.tx[txIndex] = cleanScore;
          if (cleanScore !== null) {
            subject.locks.tx[txIndex] = false;
            subject.locked.tx[txIndex] = false;
            subject.lockedValues.tx[txIndex] = null;
          }
        }
      } else if (type === 'gk') {
        subject.gk = cleanScore;
        if (cleanScore !== null) {
          subject.locks.gk = false;
          subject.locked.gk = false;
          subject.lockedValues.gk = null;
        }
      } else if (type === 'ck') {
        subject.ck = cleanScore;
        if (cleanScore !== null) {
          subject.locks.ck = false;
          subject.locked.ck = false;
          subject.lockedValues.ck = null;
        }
      }

      this._saveToStorage();
      return subject;
    }

    /**
     * Cập nhật điểm mục tiêu (target) của một môn và tự động lưu
     * @param {string} subjectId
     * @param {number|null} targetValue
     * @returns {Object|null}
     */
    updateTarget(subjectId, targetValue) {
      const subject = this.getSubjectById(subjectId);
      if (!subject) return null;

      subject.target = this._sanitizeScore(targetValue);
      this._saveToStorage();
      return subject;
    }

    /**
     * Bật/tắt trạng thái khóa (locked/locks) cho ô dự đoán và tự động lưu
     * @param {string} subjectId
     * @param {'tx'|'gk'|'ck'} type
     * @param {number} [txIndex=0]
     * @param {number|null} [lockedScore=null]
     * @returns {boolean} Trạng thái khóa mới
     */
    toggleLock(subjectId, type, txIndex = 0, lockedScore = null) {
      const subject = this.getSubjectById(subjectId);
      if (!subject) return false;

      let newState = false;
      if (type === 'tx' && txIndex >= 0 && txIndex < subject.tx.length) {
        newState = !subject.locks.tx[txIndex];
        subject.locks.tx[txIndex] = newState;
        subject.locked.tx[txIndex] = newState;
        subject.lockedValues.tx[txIndex] = newState ? this._sanitizeScore(lockedScore) : null;
      } else if (type === 'gk') {
        newState = !subject.locks.gk;
        subject.locks.gk = newState;
        subject.locked.gk = newState;
        subject.lockedValues.gk = newState ? this._sanitizeScore(lockedScore) : null;
      } else if (type === 'ck') {
        newState = !subject.locks.ck;
        subject.locks.ck = newState;
        subject.locked.ck = newState;
        subject.lockedValues.ck = newState ? this._sanitizeScore(lockedScore) : null;
      }

      this._saveToStorage();
      return newState;
    }

    /**
     * Thêm hoặc xóa cột điểm thường xuyên (TX) cho một môn (1 -> 8 cột)
     * @param {string} subjectId
     * @param {'add'|'remove'} action
     * @returns {Object|null}
     */
    modifyTxColumn(subjectId, action) {
      const subject = this.getSubjectById(subjectId);
      if (!subject) return null;

      if (action === 'add' && subject.tx.length < MAX_TX_COLUMNS) {
        subject.tx.push(null);
        subject.locks.tx.push(false);
        subject.locked.tx.push(false);
        subject.lockedValues.tx.push(null);
      } else if (action === 'remove' && subject.tx.length > MIN_TX_COLUMNS) {
        subject.tx.pop();
        subject.locks.tx.pop();
        subject.locked.tx.pop();
        subject.lockedValues.tx.pop();
      }

      this._saveToStorage();
      return subject;
    }

    /**
     * Alias thêm 1 cột TX (đồng bộ với lệnh gọi từ index.html)
     * @param {string} subjectId
     * @returns {Object|null}
     */
    addTxColumn(subjectId) {
      return this.modifyTxColumn(subjectId, 'add');
    }

    /**
     * Alias bớt 1 cột TX (đồng bộ với lệnh gọi từ index.html)
     * @param {string} subjectId
     * @returns {Object|null}
     */
    removeTxColumn(subjectId) {
      return this.modifyTxColumn(subjectId, 'remove');
    }

    /**
     * Đặt lại toàn bộ dữ liệu về 8 môn mặc định ban đầu
     * @returns {Array<Object>}
     */
    resetAllData() {
      this.state = {
        subjects: this.createDefaultSubjects(),
        updatedAt: Date.now()
      };
      this._saveToStorage();
      return this.state.subjects;
    }

    /**
     * Alias của resetAllData() để tương thích với index.html
     * @returns {Array<Object>}
     */
    resetData() {
      return this.resetAllData();
    }

    // =========================================================================
    // 2. THUẬT TOÁN TÍNH ĐIỂM & TÌM ĐIỂM THẤP NHẤT (THÔNG TƯ 22)
    // =========================================================================

    /**
     * Làm tròn số chuẩn 1 chữ số thập phân (tránh sai số dấu phẩy động)
     * @param {number} num
     * @returns {number}
     */
    _round1(num) {
      return Math.round((num + Number.EPSILON) * 10) / 10;
    }

    /**
     * Tính ĐTBm hiện tại dựa trên các ô đã có điểm thực tế (bỏ qua null).
     * Làm tròn 1 chữ số thập phân. Trả về null nếu chưa có điểm nào.
     * @param {Object} subject
     * @returns {number|null}
     */
    calculateCurrentAvg(subject) {
      if (!subject) return null;

      let weightedSum = 0;
      let totalWeight = 0;

      if (Array.isArray(subject.tx)) {
        for (let i = 0; i < subject.tx.length; i++) {
          const score = subject.tx[i];
          if (score !== null && score !== undefined && score !== '' && !Number.isNaN(Number(score))) {
            weightedSum += Number(score) * 1;
            totalWeight += 1;
          }
        }
      }

      if (subject.gk !== null && subject.gk !== undefined && subject.gk !== '' && !Number.isNaN(Number(subject.gk))) {
        weightedSum += Number(subject.gk) * 2;
        totalWeight += 2;
      }

      if (subject.ck !== null && subject.ck !== undefined && subject.ck !== '' && !Number.isNaN(Number(subject.ck))) {
        weightedSum += Number(subject.ck) * 3;
        totalWeight += 3;
      }

      if (totalWeight === 0) {
        return null;
      }

      return this._round1(weightedSum / totalWeight);
    }

    /**
     * Tính toán điểm tối thiểu cần đạt cho các ô trống để chạm mục tiêu
     * Hỗ trợ trừ điểm các ô đã khóa (lockedValues) vào quỹ điểm hiện có.
     * @param {Object} subject
     * @param {boolean} [useRoundingBuffer=true] - Trừ 0.05 để tận dụng quy tắc làm tròn (vd: 7.95 -> 8.0)
     * @returns {Object|null}
     */
    calculateTargetSuggestions(subject, useRoundingBuffer = true) {
      if (!subject || subject.target === null || subject.target === undefined || subject.target === '') {
        return null;
      }

      const targetVal = Number(subject.target);
      if (Number.isNaN(targetVal)) return null;

      const neededAvg = useRoundingBuffer ? Math.max(0, targetVal - 0.05) : targetVal;
      const txLen = Array.isArray(subject.tx) ? subject.tx.length : 3;
      const totalWeight = txLen * 1 + 2 + 3;
      const neededTotalPoints = neededAvg * totalWeight;

      let currentWeightedPoints = 0;
      let emptyWeight = 0;

      const locksObj = subject.locks || subject.locked || {};
      const lockedValsObj = subject.lockedValues || {};

      const isTxLocked = (idx) => Boolean(Array.isArray(locksObj.tx) && locksObj.tx[idx]);
      const getTxLockedVal = (idx) =>
        Array.isArray(lockedValsObj.tx) && lockedValsObj.tx[idx] !== null && lockedValsObj.tx[idx] !== undefined
          ? Number(lockedValsObj.tx[idx])
          : null;

      const isGkLocked = Boolean(locksObj.gk);
      const gkLockedVal =
        lockedValsObj.gk !== null && lockedValsObj.gk !== undefined ? Number(lockedValsObj.gk) : null;

      const isCkLocked = Boolean(locksObj.ck);
      const ckLockedVal =
        lockedValsObj.ck !== null && lockedValsObj.ck !== undefined ? Number(lockedValsObj.ck) : null;

      // Duyệt các cột Thường xuyên (hệ số 1)
      for (let idx = 0; idx < txLen; idx++) {
        const score = subject.tx[idx];
        const hasScore = score !== null && score !== undefined && score !== '' && !Number.isNaN(Number(score));
        if (hasScore) {
          currentWeightedPoints += Number(score) * 1;
        } else if (isTxLocked(idx)) {
          const lockedVal = getTxLockedVal(idx);
          if (lockedVal !== null && !Number.isNaN(lockedVal)) {
            currentWeightedPoints += lockedVal * 1;
          }
        } else {
          emptyWeight += 1;
        }
      }

      // Duyệt cột Giữa kỳ (hệ số 2)
      const hasGk = subject.gk !== null && subject.gk !== undefined && subject.gk !== '' && !Number.isNaN(Number(subject.gk));
      if (hasGk) {
        currentWeightedPoints += Number(subject.gk) * 2;
      } else if (isGkLocked) {
        if (gkLockedVal !== null && !Number.isNaN(gkLockedVal)) {
          currentWeightedPoints += gkLockedVal * 2;
        }
      } else {
        emptyWeight += 2;
      }

      // Duyệt cột Cuối kỳ (hệ số 3)
      const hasCk = subject.ck !== null && subject.ck !== undefined && subject.ck !== '' && !Number.isNaN(Number(subject.ck));
      if (hasCk) {
        currentWeightedPoints += Number(subject.ck) * 3;
      } else if (isCkLocked) {
        if (ckLockedVal !== null && !Number.isNaN(ckLockedVal)) {
          currentWeightedPoints += ckLockedVal * 3;
        }
      } else {
        emptyWeight += 3;
      }

      // Điểm trung bình cao nhất có thể đạt nếu tất cả ô trống chưa khóa đều được 10
      const maxPossibleAvg = this._round1((currentWeightedPoints + emptyWeight * 10) / totalWeight);

      // Trường hợp không còn ô trống tự do nào để gợi ý (đã nhập hết hoặc khóa hết)
      if (emptyWeight === 0) {
        const finalAvg = this._round1(currentWeightedPoints / totalWeight);
        const isReached = currentWeightedPoints + 1e-9 >= neededTotalPoints;
        return {
          status: isReached ? 'achieved' : 'impossible',
          minScore: isReached ? 0 : 10,
          maxPossibleAvg: finalAvg,
          suggestedScores: {
            tx: Array.from({ length: txLen }, (_, idx) => {
              const s = subject.tx[idx];
              const hasS = s !== null && s !== undefined && s !== '' && !Number.isNaN(Number(s));
              return !hasS && isTxLocked(idx) ? getTxLockedVal(idx) : null;
            }),
            gk: !hasGk && isGkLocked ? gkLockedVal : null,
            ck: !hasCk && isCkLocked ? ckLockedVal : null
          }
        };
      }

      // Tính điểm tối thiểu cần đạt cho mỗi ô trống
      const rawMinScore = (neededTotalPoints - currentWeightedPoints) / emptyWeight;

      // Làm tròn lên 0.1 (ví dụ: 7.12 -> 7.2), trừ epsilon nhỏ để tránh lỗi dấu phẩy động
      const ceiledMinScore = Math.ceil((rawMinScore - 1e-9) * 10) / 10;

      let status = 'possible';
      if (ceiledMinScore <= 0) {
        status = 'achieved';
      } else if (ceiledMinScore > 10) {
        status = 'impossible';
      }

      const clampedMinScore = Math.min(10, Math.max(0, Number(ceiledMinScore.toFixed(1))));
      const suggestionValue = status === 'achieved' ? 0 : clampedMinScore;

      const suggestedTx = Array.from({ length: txLen }, (_, idx) => {
        const score = subject.tx[idx];
        const hasScore = score !== null && score !== undefined && score !== '' && !Number.isNaN(Number(score));
        if (hasScore) return null;
        if (isTxLocked(idx)) return getTxLockedVal(idx);
        return suggestionValue;
      });

      const suggestedGk = hasGk ? null : isGkLocked ? gkLockedVal : suggestionValue;
      const suggestedCk = hasCk ? null : isCkLocked ? ckLockedVal : suggestionValue;

      return {
        status,
        minScore: clampedMinScore,
        maxPossibleAvg,
        suggestedScores: {
          tx: suggestedTx,
          gk: suggestedGk,
          ck: suggestedCk
        }
      };
    }

    /**
     * Tính tổng kết học kỳ và xếp loại học lực theo Thông tư 22/2021/TT-BGDĐT
     * @param {Array<Object>} [subjects] - Mặc định dùng danh sách môn trong state
     * @returns {{ overallAvg: number|null, rank: string, warningSubjects: Array<Object> }}
     */
    calculateSemesterSummary(subjects) {
      const list = Array.isArray(subjects) ? subjects : this.state.subjects;
      const evaluated = [];

      for (let i = 0; i < list.length; i++) {
        const sub = list[i];
        const currentAvg = this.calculateCurrentAvg(sub);
        const hasEmpty =
          (Array.isArray(sub.tx) && sub.tx.some((v) => v === null || v === undefined || v === '')) ||
          sub.gk === null ||
          sub.gk === undefined ||
          sub.gk === '' ||
          sub.ck === null ||
          sub.ck === undefined ||
          sub.ck === '';

        // Ưu tiên điểm thực tế nếu đã nhập; nếu chưa có điểm nào nhưng có target thì lấy target dự phóng
        let effectiveAvg = currentAvg;
        let isProjected = false;

        if (effectiveAvg === null && hasEmpty && sub.target !== null && sub.target !== undefined && sub.target !== '') {
          effectiveAvg = Number(sub.target);
          isProjected = true;
        }

        if (effectiveAvg !== null && !Number.isNaN(effectiveAvg)) {
          evaluated.push({
            id: sub.id,
            name: sub.name,
            avg: effectiveAvg,
            isProjected
          });
        }
      }

      if (evaluated.length === 0) {
        return {
          overallAvg: null,
          rank: 'Chưa xếp loại',
          warningSubjects: []
        };
      }

      const sumAvg = evaluated.reduce((acc, item) => acc + item.avg, 0);
      const overallAvg = this._round1(sumAvg / evaluated.length);

      const countGe80 = evaluated.filter((s) => s.avg >= 8.0).length;
      const countGe65 = evaluated.filter((s) => s.avg >= 6.5).length;
      const countLt50 = evaluated.filter((s) => s.avg < 5.0).length;
      const countLt35 = evaluated.filter((s) => s.avg < 3.5).length;

      const allGe65 = evaluated.every((s) => s.avg >= 6.5);
      const allGe50 = evaluated.every((s) => s.avg >= 5.0);

      let rank = 'Chưa đạt';
      if (allGe65 && countGe80 >= 6) {
        rank = 'Tốt';
      } else if (allGe50 && countGe65 >= 6) {
        rank = 'Khá';
      } else if (countLt50 <= 1 && countLt35 === 0) {
        rank = 'Đạt';
      } else {
        rank = 'Chưa đạt';
      }

      const warningSubjects = [];
      if (rank === 'Chưa đạt') {
        evaluated.forEach((s) => {
          if (s.avg < 3.5) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 3.5 (khống chế mức Chưa đạt)'
            });
          } else if (s.avg < 5.0) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 5.0 (cần tối đa 1 môn dưới 5.0 để lên Đạt)'
            });
          }
        });
      } else if (rank === 'Đạt') {
        evaluated.forEach((s) => {
          if (s.avg < 5.0) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 5.0 (đang chặn điều kiện lên mức Khá)'
            });
          } else if (s.avg < 6.5 && countGe65 < 6) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 6.5 (cần đủ 6 môn >= 6.5 để lên mức Khá)'
            });
          }
        });
      } else if (rank === 'Khá') {
        evaluated.forEach((s) => {
          if (s.avg < 6.5) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 6.5 (đang chặn điều kiện lên mức Tốt)'
            });
          } else if (s.avg < 8.0 && countGe80 < 6) {
            warningSubjects.push({
              id: s.id,
              name: `${s.name} (${s.avg.toFixed(1)})`,
              avg: s.avg,
              reason: 'Dưới 8.0 (cần đủ 6 môn >= 8.0 để lên mức Tốt)'
            });
          }
        });
      }

      return {
        overallAvg,
        rank,
        warningSubjects
      };
    }

    // =========================================================================
    // 3. SAO LƯU BASE64 + DJB2 CHECKSUM & TIỆN ÍCH
    // =========================================================================

    _djb2Hash(str) {
      let hash = 5381;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    _utf8ToBase64(str) {
      const bytes = new TextEncoder().encode(str);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return global.btoa(binary);
    }

    _base64ToUtf8(base64) {
      const binary = global.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }

    exportDataBase64() {
      const payloadJson = JSON.stringify({
        v: 1,
        subjects: this.state.subjects
      });
      const checksum = this._djb2Hash(payloadJson);
      const encodedPayload = this._utf8ToBase64(payloadJson);
      return `${checksum}.${encodedPayload}`;
    }

    importDataBase64(str) {
      if (typeof str !== 'string' || !str.trim()) {
        throw new Error('Chuỗi sao lưu trống hoặc không hợp lệ.');
      }

      const trimmed = str.trim();
      const dotIndex = trimmed.indexOf('.');
      if (dotIndex !== 8) {
        throw new Error('Định dạng mã sao lưu không đúng (thiếu mã kiểm tra toàn vẹn).');
      }

      const providedChecksum = trimmed.slice(0, 8).toLowerCase();
      const encodedPayload = trimmed.slice(9);

      if (!encodedPayload) {
        throw new Error('Nội dung dữ liệu sao lưu bị thiếu.');
      }

      let payloadJson = '';
      try {
        payloadJson = this._base64ToUtf8(encodedPayload);
      } catch (e) {
        throw new Error('Không thể giải mã Base64. Chuỗi sao lưu đã bị hỏng hoặc thiếu ký tự.');
      }

      const calculatedChecksum = this._djb2Hash(payloadJson);
      if (providedChecksum !== calculatedChecksum) {
        throw new Error('Mã kiểm tra toàn vẹn (Checksum) không khớp.');
      }

      let parsed;
      try {
        parsed = JSON.parse(payloadJson);
      } catch (e) {
        throw new Error('Dữ liệu JSON bên trong bản sao lưu bị lỗi.');
      }

      if (!parsed || !Array.isArray(parsed.subjects) || parsed.subjects.length === 0) {
        throw new Error('Danh sách môn học trong bản sao lưu không hợp lệ.');
      }

      const normalizedSubjects = parsed.subjects.map((sub) => this._normalizeSubject(sub));
      this.state = {
        subjects: normalizedSubjects,
        updatedAt: Date.now()
      };
      this._saveToStorage();

      return {
        success: true,
        subjects: this.state.subjects
      };
    }

    /**
     * Chuyển đổi nhập nhanh 1-3 phím thành điểm số hợp lệ [0, 10]
     * Ví dụ: "85" -> 8.5 | "7" -> 7.0 | "10" -> 10.0 | "925" -> 9.25 | "8,5" -> 8.5
     * @param {string|number} rawStr
     * @returns {number|null}
     */
    parseQuickInput(rawStr) {
      if (rawStr === null || rawStr === undefined) return null;
      const cleaned = String(rawStr).trim().replace(/,/g, '.');
      if (cleaned === '') return null;

      let parsedValue = NaN;

      if (cleaned.includes('.')) {
        // Cho phép cả trường hợp người dùng đang gõ dở dấu chấm như "8." -> 8.0
        if (!/^\d{1,2}(\.\d{0,2})?$/.test(cleaned)) {
          return null;
        }
        parsedValue = parseFloat(cleaned);
      } else {
        if (!/^\d{1,3}$/.test(cleaned)) {
          return null;
        }

        if (cleaned === '10' || cleaned === '100') {
          parsedValue = 10.0;
        } else if (cleaned.length === 1) {
          parsedValue = parseInt(cleaned, 10);
        } else if (cleaned.length === 2) {
          parsedValue = parseInt(cleaned, 10) / 10;
        } else if (cleaned.length === 3) {
          parsedValue = parseInt(cleaned, 10) / 100;
        }
      }

      if (Number.isNaN(parsedValue) || parsedValue < 0 || parsedValue > 10) {
        return null;
      }

      return Math.round(parsedValue * 100) / 100;
    }

    /**
     * Tạo hiệu ứng âm thanh phản hồi bằng Web Audio API
     * Hỗ trợ: 'click' | 'input' | 'clear' | 'lock' | 'chime'
     * @param {'click'|'input'|'clear'|'lock'|'chime'} [type='click']
     */
    playFeedbackSound(type = 'click') {
      try {
        const AudioContextClass = global.AudioContext || global.webkitAudioContext;
        if (!AudioContextClass) return;

        if (!this._audioCtx) {
          this._audioCtx = new AudioContextClass();
        }
        if (this._audioCtx.state === 'suspended') {
          this._audioCtx.resume();
        }

        const ctx = this._audioCtx;
        const now = ctx.currentTime;

        if (type === 'click') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(900, now);
          osc.frequency.exponentialRampToValueAtTime(240, now + 0.035);
          gain.gain.setValueAtTime(0.16, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.04);
        } else if (type === 'input') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(520, now);
          osc.frequency.exponentialRampToValueAtTime(760, now + 0.055);
          gain.gain.setValueAtTime(0.14, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.06);
        } else if (type === 'clear') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(420, now);
          osc.frequency.exponentialRampToValueAtTime(190, now + 0.065);
          gain.gain.setValueAtTime(0.14, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.07);
        } else if (type === 'lock') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(640, now);
          osc.frequency.setValueAtTime(860, now + 0.03);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.08);
        } else if (type === 'chime') {
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const startTime = now + idx * 0.075;
            const duration = 0.32;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startTime);
            gain.gain.setValueAtTime(0.001, startTime);
            gain.gain.linearRampToValueAtTime(0.14, startTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + duration + 0.02);
          });
        }
      } catch (err) {
        // Bỏ qua nếu trình duyệt chặn autoplay audio
      }
    }
  }

  global.GradeEngine = new GradeEngineClass();
})(typeof window !== 'undefined' ? window : globalThis);