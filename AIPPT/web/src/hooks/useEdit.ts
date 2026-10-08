import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppState } from '../contexts/useAppState'
import { editImage } from '../services/editService'
import { EditSession, EditHistoryItem, Slide } from '../types'

function cloneEditHistory(history: EditHistoryItem[] = []): EditHistoryItem[] {
  return history.map(item => ({ ...item }))
}

/**
 * 编辑会话管理 Hook
 * 实现多轮编辑逻辑，每次编辑基于最新版本，保存所有历史版本
 * Requirements: 7.4, 7.5, 7.6, 8.2
 */
export function useEdit() {
  const { state, startEdit, updateEdit, endEdit, updateSlide, selectSlide } = useAppState()
  const [isEditing, setIsEditing] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const editSessionVersionRef = useRef(0)
  const editRequestIdRef = useRef(0)
  const latestEditingSlideRef = useRef(state.editingSlide)

  useEffect(() => {
    latestEditingSlideRef.current = state.editingSlide
  }, [state.editingSlide])

  /**
   * 开始编辑一个幻灯片
   */
  const beginEdit = useCallback((slide: Slide) => {
    // 获取图片的 base64 数据
    const imageBase64 = slide.imageBase64 || ''
    const imageUrl = slide.imageUrl || (imageBase64 ? `data:image/png;base64,${imageBase64}` : '')
    const history = cloneEditHistory(slide.editHistory)

    const session: EditSession = {
      slideId: slide.id,
      originalImage: imageBase64 || imageUrl,
      currentImage: imageBase64 || imageUrl,
      history,
      savedHistoryLength: history.length,
      userInput: ''
    }

    editSessionVersionRef.current += 1
    editRequestIdRef.current += 1
    startEdit(session)
    setIsEditing(false)
    setEditError(null)
  }, [startEdit])

  /**
   * 提交编辑指令
   * 每次编辑基于最新版本
   */
  const submitEdit = useCallback(async (instruction: string) => {
    const editSession = state.editingSlide
    if (!editSession) return
    const sessionVersion = editSessionVersionRef.current
    const requestId = editRequestIdRef.current + 1
    editRequestIdRef.current = requestId

    setIsEditing(true)
    setEditError(null)

    try {
      // 获取当前图片的 base64（去掉 data:image/png;base64, 前缀）
      let currentBase64 = editSession.currentImage
      if (currentBase64.startsWith('data:')) {
        currentBase64 = currentBase64.split(',')[1]
      }
      const editConfig = state.fullApiConfig.edit || state.fullApiConfig.image
      const hasCompleteModelConfig = Boolean(
        state.fullApiConfig.text.apiKey && state.fullApiConfig.text.baseUrl &&
        state.fullApiConfig.image.apiKey && state.fullApiConfig.image.baseUrl &&
        editConfig.apiKey && editConfig.baseUrl
      )

      const response = await editImage({
        image_base64: currentBase64,
        instruction,
        config: {
          ...(hasCompleteModelConfig
            ? {
              api_key: editConfig.apiKey,
              base_url: editConfig.baseUrl,
              model: editConfig.model,
              model_profiles: {
                text_model: {
                  model: state.fullApiConfig.text.model,
                  base_url: state.fullApiConfig.text.baseUrl,
                  api_key: state.fullApiConfig.text.apiKey
                },
                image_model: {
                  model: state.fullApiConfig.image.model,
                  base_url: state.fullApiConfig.image.baseUrl,
                  api_key: state.fullApiConfig.image.apiKey
                },
                edit_model: {
                  model: editConfig.model,
                  base_url: editConfig.baseUrl,
                  api_key: editConfig.apiKey
                }
              }
            }
            : {}),
          quality: state.generationConfig.quality,
          aspect_ratio: state.generationConfig.aspectRatio
        }
      })

      if (response.success && response.image_base64) {
        if (
          editRequestIdRef.current !== requestId ||
          editSessionVersionRef.current !== sessionVersion ||
          latestEditingSlideRef.current?.slideId !== editSession.slideId
        ) {
          return
        }

        // 保存当前版本到历史
        const historyItem: EditHistoryItem = {
          imageUrl: editSession.currentImage.startsWith('data:')
            ? editSession.currentImage
            : `data:image/png;base64,${editSession.currentImage}`,
          imageBase64: currentBase64,
          instruction,
          timestamp: Date.now()
        }

        // 更新编辑会话
        updateEdit({
          currentImage: response.image_base64,
          history: [...editSession.history, historyItem],
          userInput: ''
        })
      } else {
        throw new Error(response.message || '编辑失败')
      }
    } catch (error) {
      if (
        editRequestIdRef.current !== requestId ||
        editSessionVersionRef.current !== sessionVersion ||
        latestEditingSlideRef.current?.slideId !== editSession.slideId
      ) {
        return
      }
      setEditError(error instanceof Error ? error.message : '编辑失败')
    } finally {
      if (editRequestIdRef.current === requestId) {
        setIsEditing(false)
      }
    }
  }, [state.editingSlide, state.fullApiConfig, state.generationConfig, updateEdit])

  /**
   * 回退到历史版本
   */
  const revertToVersion = useCallback((historyItem: EditHistoryItem) => {
    if (!state.editingSlide) return

    // 找到历史记录的索引
    const index = state.editingSlide.history.findIndex(
      h => h.timestamp === historyItem.timestamp
    )

    if (index >= 0) {
      // 保留该版本之前的历史（不包括该版本）
      const newHistory = cloneEditHistory(state.editingSlide.history.slice(0, index))

      editSessionVersionRef.current += 1
      editRequestIdRef.current += 1
      setIsEditing(false)
      updateEdit({
        currentImage: historyItem.imageBase64,
        history: newHistory,
        savedHistoryLength: Math.min(state.editingSlide.savedHistoryLength ?? 0, newHistory.length)
      })
    }
  }, [state.editingSlide, updateEdit])

  /**
   * 确认编辑 - 替换原图
   * 确认后立即更新预览，更新 slides 数组中对应项
   * Requirements: 7.5, 8.2
   */
  const confirmEdit = useCallback(() => {
    if (!state.editingSlide) return

    // 获取当前图片的 base64
    let currentBase64 = state.editingSlide.currentImage
    if (currentBase64.startsWith('data:')) {
      currentBase64 = currentBase64.split(',')[1]
    }

    const slideId = state.editingSlide.slideId
    const existingSlide = state.slides.find(slide => slide.id === slideId) ||
      state.lastCompletedSlides.find(slide => slide.id === slideId)
    if (!existingSlide) {
      setEditError('无法确认编辑：幻灯片不存在')
      return
    }

    const editHistory = cloneEditHistory(state.editingSlide.history)

    // 更新幻灯片 - 这会立即更新预览面板
    updateSlide(slideId, {
      imageBase64: currentBase64,
      imageUrl: `data:image/png;base64,${currentBase64}`,
      editHistory,
      updatedAt: Date.now()
    })

    // 保持选中状态，确保用户可以看到更新后的幻灯片
    selectSlide(slideId)

    // 结束编辑
    editSessionVersionRef.current += 1
    editRequestIdRef.current += 1
    endEdit()
    setIsEditing(false)
    setEditError(null)
  }, [state.editingSlide, state.slides, state.lastCompletedSlides, updateSlide, selectSlide, endEdit])

  /**
   * 取消编辑 - 丢弃所有编辑
   * Requirements: 7.6
   */
  const cancelEdit = useCallback(() => {
    editSessionVersionRef.current += 1
    editRequestIdRef.current += 1
    endEdit()
    setIsEditing(false)
    setEditError(null)
  }, [endEdit])

  return {
    editSession: state.editingSlide,
    isEditing,
    editError,
    beginEdit,
    submitEdit,
    revertToVersion,
    confirmEdit,
    cancelEdit
  }
}
