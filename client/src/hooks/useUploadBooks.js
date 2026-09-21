import { useCallback, useState } from 'react';
import { uploadBook } from '../api/booksApi.js';

const noop = () => {};

export function useUploadBooks({ loadShelf = noop, setError = noop } = {}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');

  const handleFileChange = useCallback(
    async (event) => {
      if (isUploading) {
        event.target.value = '';
        return;
      }

      const files = Array.from(event.target.files || []);

      if (!files.length) {
        return;
      }

      setIsUploading(true);
      setUploadProgress(`正在上传 1/${files.length}`);
      setError('');

      try {
        const failedFiles = [];

        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];

          setUploadProgress(`正在上传 ${index + 1}/${files.length}`);

          try {
            await uploadBook(file);
          } catch (error) {
            const fileName = file.name || '未命名文件';
            failedFiles.push(`${fileName}（${error.message || '上传失败'}）`);
          }
        }

        setUploadProgress('正在更新书架');
        await loadShelf();

        if (failedFiles.length) {
          const successCount = files.length - failedFiles.length;

          setError(
            `${successCount} 本上传完成，${failedFiles.length} 本失败：${failedFiles.join('、')}`,
          );
        }
      } catch (err) {
        setError(err.message || '上传失败');
      } finally {
        setIsUploading(false);
        setUploadProgress('');
        event.target.value = '';
      }
    },
    [isUploading, loadShelf, setError],
  );

  return {
    handleFileChange,
    isUploading,
    uploadProgress,
  };
}
